const axios = require('axios')
const cheerio = require('cheerio')
const WebSocket = require('ws')

module.exports = class FKGSWS {
    constructor() {
        this.url = 'wss://fkgs.gosuslugi.ru/centrifugo/connection/websocket'
        this.socket = null
        this.clientId = null
        this.reconnectAttempts = 0
        this.maxReconnectAttempts = 5
        this.reconnectInterval = 3000
        this.messageQueue = []
        this.lastMessageId = 0
        this.pendingAuth = false
        this.sessionCookie = null
        this.csrfToken = null
        this.currentData = { channels: [] }
        this.subs = []
    }

    async connect() {
        try {
            await this.initSession()
            this.initSocket()
            return true
        } catch (error) {
            console.error('Initial connection failed:', error)
            this.handleReconnect()
            return false
        }
    }

    async initSession() {
        try {
            const req = await axios.get('https://pos.gosuslugi.ru/lkp/fkgs/', {
                withCredentials: true
            });
            
            const $ = cheerio.load(req.data)
            const csrfToken = $('meta[name="csrf-token"]').attr('content')
            const sessionCookie = req.headers['set-cookie'].find(cookie => cookie.includes('SESSIONID=')).split('SESSIONID=')[1].split(';')[0]
            
            if (!csrfToken || !sessionCookie) {
                throw new Error('CSRF token or session cookie not found')
            }
            this.csrfToken = csrfToken
            this.sessionCookie = sessionCookie
            return true

        } catch (error) {
            throw new Error(`Failed to init session: ${error.message}`)
        }
    }

    initSocket() {
        this.socket = new WebSocket(this.url)
        this.pendingAuth = true

        this.socket.onopen = async () => {
            console.log('Connected. Auth in progress...')
            this.reconnectAttempts = 0
            await this.auth()
        }

        this.socket.onmessage = (event) => this.handleMessage(event)
        this.socket.onclose = () => this.handleDisconnect()
        this.socket.onerror = (error) => this.handleError(error)
    }

    async auth() {
        try {
            const authToken = await this.getAuthToken()
            const data = {
                id: ++this.lastMessageId,
                connect: {
                    token: authToken,
                    name: 'js'
                }
            }
            this.send(data)
        } catch (error) {
            console.error('Auth error:', error)
            this.socket?.close()
        }
    }

    handleAuthResponse(response) {
        if (this.pendingAuth && response.connect) {
            this.clientId = response.connect.client
            this.pendingAuth = false
            console.log('Auth success. Client ID:', this.clientId)
            this.processMessageQueue()
        }
    }

    async getAuthToken() {
        try {
            const headers = {
                'x-csrf-token': this.csrfToken,
                'cookie': `SESSIONID=${this.sessionCookie}`,
            }
            
            const response = await axios.post(
                'https://pos.gosuslugi.ru/lkp/fkgs/wss-token/', 
                {}, 
                { headers }
            )
            
            return response.data.token
        } catch (error) {
            throw new Error(`Failed to get auth token: ${error.message}`)
        }
    }

    handleMessage(event) {
        const messages = event.data.split('\n').filter(msg => msg.trim())
        
        for (const raw of messages) {
            try {
                if (raw === '{}') {
                    this.ping()
                    continue;
                }

                const data = JSON.parse(raw)
                
                if (data.id === 1 && data.connect) {
                    this.handleAuthResponse(data)
                    continue
                }

                this.processMessage(data)
            } catch (error) {
                console.error('Error parsing message:', raw, error);
            }
        }
    }


    processMessage(data) {
        switch (true) {
            case 'push' in data:
                this.updateChannelData(
                    data.push.channel,
                    data.push.pub.data,
                    'push'
                );
                this.notifySubs(data)
                break;
            case 'history' in data:
                this.updateChannelData(
                    data.id,
                    data.history.publications[0]?.data,
                    'history'
                );
                break;
            default:
            	break;
        }
    }

    subscribe(_callback){
        this.subs.push(_callback)
    }

    notifySubs(data){
        for(let callback of this.subs){
            callback(data)
        }
    }

    updateChannelData(channelId, count) {
        this.currentData.channels = this.currentData.channels.filter(c => c.id !== channelId)
            
        this.currentData.channels.push({
            id: channelId.toString(),
            count: count
        })
        
    }

    initHistoryAndSub() {
        this.send({ history: { channel: "97080", limit: 1 }, id: 97080 })
        this.send({ history: { channel: "97101", limit: 1 }, id: 97101 })
        this.send({ subscribe: { channel: "97080" }, id: 4 })
        this.send({ subscribe: { channel: "97101" }, id: 5 })
    }

    handleDisconnect() {
        console.log('WebSocket disconnected')
        this.handleReconnect()
    }

    handleError(error) {
        console.error('WebSocket error:', error)
    }

    handleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++
            console.log(`Trying to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`)
            
            setTimeout(() => {
                this.connect();
            }, this.reconnectInterval)
        } else {
            console.error('FKGS Died. Give up')
        }
    }

    send(data) {
        if (!data.id) {
            data.id = ++this.lastMessageId
        }
        
        if (this.isConnected()) {
            this.socket.send(JSON.stringify(data))
        } else {
            console.log(`not ready. will send later. (con state: ${this.isConnected()})`)
            this.messageQueue.push(data)
        }
    }

    ping() {
        if (this.isConnected()) {
            this.socket.send(JSON.stringify({}))
        }
    }

    processMessageQueue() {
        while (this.messageQueue.length > 0 && this.isConnected()) {
            const message = this.messageQueue.shift()
            this.send(message)
        }
    }

    isConnected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN
    }

    close() {
        if (this.socket) {
            this.socket.close()
        }
    }
}
