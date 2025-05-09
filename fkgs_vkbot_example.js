let vktoken = "vk token"
let eventspeerid = "2000000001"
let os = require("os")
let fs = require('fs')
let cron = require('node-cron');

let LC = 0;
let LCFILE = "./lastcount"
initCounter()

const { VK, resolveResource, Keyboard } = require("vk-io");
const { HearManager } = require("@vk-io/hear");

let fkgsclient = require("./fkgs_client.js")
let fc = new fkgsclient()

fc.connect();
fc.initHistoryAndSub();
fc.subscribe(sendLog)

const vk = new VK({
    token: vktoken,
});

cron.schedule('0 0 * * *', saveCounter);

const hearManager = new HearManager();
vk.updates.on("message_new", hearManager.middleware);

hearManager.hear(["/ф","/фкгс","/f"], async (context) => {
	let {total,channels,comment} = await fc.getCurrentData()

	context.send(
		`Всего: ${Number(total)}${os.EOL}`+
		`За день: ${Number(total) - Number(LC)}${os.EOL}`+
		`Осталось: ${7000 - Number(total)}${os.EOL}${os.EOL}`+
		`${channels.join(os.EOL+os.EOL)}${os.EOL}${os.EOL}`+
		`До конца голосования осталось ${daysLeft()} дн.${os.EOL}`+comment
	)
})

function sendLog(data){
	let msg = '';

	let total = 0
	let channels = fc.currentData.channels
	let resch = []
	for(let channel of channels){
		switch(channel.id){
			case "97080":
				resch.push(`🏥 Металлургов: ${channel.count}`)
				total += channel.count
				break;
			case "97101":
				resch.push(`🏘️ Ленина: ${channel.count}`)
				total += channel.count
				break;
		}
	}
	switch(data.push.channel){
		case "97080":
			msg = `🏥 Металлургов +1 (${data.push.pub.data})`
			break;
		case "97101":
			msg = `🏘️ Ленина +1 (${data.push.pub.data})`
			break;
	}
	let text = `${msg}\n\nВсего: ${total}${os.EOL}`
	vk.api.messages.send({
		peer_id: eventspeerid,
		random_id: 0,
		message: text
	})
}

function initCounter() {
	if (fs.existsSync(LCFILE)) {
		let lc = fs.readFileSync(LCFILE, 'utf8')
		if (!isNaN(lc)) {
			LC = lc;
		}
	}else{
		console.log('last_count set to 0 coz there is no last count file')
	}
}

function saveCounter() {
	fc.getCurrentData().then((data) => {
		LC = data.total
		fs.writeFileSync(LCFILE, data.total);
	})
}

function daysLeft(){
	return Math.ceil((new Date(new Date().getFullYear() + (new Date() > new Date(new Date().getFullYear(), 5, 12)), 5, 12) - new Date()) / 86400000);
}

vk.updates.start().catch(console.error);
