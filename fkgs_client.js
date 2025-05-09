const qs = require('querystring'); 
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

            await this.changeLocation()
            
            return true

        } catch (error) {
            throw new Error(`Failed to init session: ${error.message}`)
        }
    }

    //@trick to skip broken centrifugo

    async changeLocation(){
        let data = qs.stringify({
            "_csrf": this.csrfToken,
            "location": "custom_region",
            "region": "68ba4d184a72297f5a12b5d92d9e272f"
        })
        let headers = {
            'accept': 'application/json, text/javascript, */*; q=0.01',
            'accept-language': 'ru-RU,ru;q=0.9',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-csrf-token': this.csrfToken,
            'x-requested-with': 'XMLHttpRequest',
            'cookie': `SESSIONID=${this.sessionCookie}`,
            'Referer': 'https://pos.gosuslugi.ru/lkp/fkgs/'
        }
        const loc =  await axios.post('https://pos.gosuslugi.ru/lkp/site/location-change/', data , {headers: headers, withCredentials: true})
        console.log(loc.data)
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
                console.log(data)
                this.processMessage(data)
            } catch (error) {
                console.error('Error parsing message:', raw, error);
            }
        }
    }


    processMessage(data) {
        switch (true) {
            case 'push' in data:
                const channelId = data.push.channel;
                const newCount = data.push.pub.data;
                
                const existingChannel = this.currentData.channels.find(c => c.id === channelId);
                
                if (!existingChannel || existingChannel.count !== newCount) {
                    this.updateChannelData(channelId, newCount);
                    this.notifySubs(data);
                }

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

    //@trick to skip broken centrifugo

    async getChannelsHard(){
        try {
            await this.initSession()
            const headers = {
                'x-csrf-token': this.csrfToken,
                'cookie': `SESSIONID=${this.sessionCookie}`
            }
            const response = await axios.get('https://pos.gosuslugi.ru/lkp/fkgs/?location=m47524000&typeView=&typeView=1&type=&type=2', {headers: headers})
            const $ = cheerio.load(response.data)
            const counters = []
            $('li.proposal-list__item--userless').each((index, element) => {
                const $el = $(element)
                const counterSpan = $el.find('[data-ws-counter-id]')
                const counterId = counterSpan.attr('data-ws-counter-id')
                const counterValue = counterSpan.text().trim()
                
                counters.push({
                    id: counterId,
                    count: counterValue
                })
            })
            return {
                "channels":counters
            }

        } catch (error) {
            console.error('Error fetching counters:', error);
            throw error;
        }
    }

    async getCurrentData() {
        const currentChannels = this.currentData.channels;
        const hardChannelsData = await this.getChannelsHard();
        const hardChannels = hardChannelsData.channels;
    
        let total = 0
        const resch = []
        let websocketStatus = '\nСтатус:\n✅ centrifugo'
    
        const hardChannelsMap = new Map(hardChannels.map(ch => [ch.id, ch.count]));
    
        for (const currentChannel of currentChannels) {
            const channelId = currentChannel.id
            const hardCount = hardChannelsMap.get(channelId) || 0
            const currentCount = currentChannel.count
    
            const finalCount = Math.max(currentCount, hardCount);
    
            if (hardCount > currentCount) {
                websocketStatus = '\nСтатус:\n❌ centrifugo  ✅ gosuslugi';
                currentChannel.count = hardCount;
            }
    
            total += finalCount;
    
            const channelInfo = this.getChannelDisplayInfo(channelId);
            resch.push(`${channelInfo.emoji} ${channelInfo.name}: ${finalCount}`);
        }
    
        return {
            total,
            channels: resch,
            comment: websocketStatus
        };
    }
    
    getChannelDisplayInfo(channelId) {
        const channelsInfo = {
            "97080": { emoji: "🏥", name: "Металлургов" },
            "97101": { emoji: "🏘️", name: "Ленина" }
        };
    
        return channelsInfo[channelId] || { emoji: "ℹ️", name: "Unknown" };
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
