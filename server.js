const dgram = require('dgram');
const { Readable } = require('stream');
const { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkPacketRegistry, minimal, common, ardupilotmega, uavionix, send } = require('node-mavlink');
const express = require('express');
const { Console } = require('console');
const fs = require('fs');
// const os = require('os');

const WebSocket = require('ws');
const http = require('http');

const { router, init } = require('./api');

const cors = require('cors');

const database = require('./database');

const app = express();

const timeOfTakeOff = null;

app.use('/api', router);
app.use(express.json());
app.use(cors());

const {
    convertTimestringToISO8601,
    getLocalIP,
    replaceBigIntWithString
} = require('./utils')

// database.clearDatabase();

const db = database.initializeDatabase();


console.log(`My IP is ${getLocalIP()}`);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
//Web socket clients
let clients = [];

let datastore = {};
let newMessageList = {};

// Create a UDP socket
const udpSocket = dgram.createSocket('udp4');

// Listen for messages assigned port
udpSocket.bind(14559, '0.0.0.0');

//Web sockets stuff..
wss.on('connection', (ws) => {
    ws.subscriptions = new Set();

    clients.push(ws);
    console.log('Client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.subscribe && Array.isArray(data.subscribe)) {
                ws.subscriptions = new Set(data.subscribe.map(String));
                console.log(`Client subscriptions updated: ${[...ws.subscriptions].join(', ')}`);
            }
        } catch (e) {
            console.error('Invalid message from client:', message);
        }
    });

    ws.on('close', () => {
        clients = clients.filter(client => client !== ws);
        console.log('Client disconnected');
    });
});



// Custom Readable stream that listens for messages from UDP socket
class UDPReadable extends Readable {
    constructor(socket, options) {
        super(options);
        this.socket = socket;
        this.socket.on('message', this.handleMessage.bind(this));
    }

    handleMessage(msg, rinfo) {
        // console.log("---");
        // Push the received message into the stream
        this.push(msg);
    }

    // _read method is required for a Readable stream
    _read() { }
}

// Create an instance of the custom Readable stream
const udpReadable = new UDPReadable(udpSocket);
const port = udpReadable.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());


const REGISTRY = {
    ...minimal.REGISTRY,
    ...common.REGISTRY,
    ...ardupilotmega.REGISTRY,
    ...uavionix.REGISTRY
}




const getData = (packet) => {
    if(!REGISTRY.hasOwnProperty(packet.header.msgid)){
        console.log("Warning: Unknown message ID");
        return null
    }
    //console.log(packet);
    
    const clazz = REGISTRY[packet.header.msgid]

    const result = packet.protocol.data(packet.payload, clazz);

    result.msg_name = clazz.MSG_NAME;
    //result.msg_name = packet.header.msgid;
    result[clazz.MSG_NAME] = packet.protocol.data(packet.payload, clazz);
    return result;
}

port.on('data', packet => {
    
    const key = packet.header.msgid;
    const message = getData(packet);
    if(message==null) return
    const msgid = packet.header.msgid;
    // console.log(message);
    
    
    // Sjekker om man tidligere har mottatt en melding med samme msgid, sysid og compid
    // Hvis ikke, skrives det ut en melding til konsollen
    // OBS: Datastore støtter ikke dette, og vil kun lagre siste versjon av hver meldingstype

    const longKey = `${packet.header.msgid}-${packet.header.sysid}-${packet.header.compid}`;
    if (!newMessageList.hasOwnProperty(longKey)) {
        if(process.stdout.isTTY){
	process.stdout.clearLine();
        process.stdout.cursorTo(0);	
	
        const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false }); // Local time in HH:mm:ss format
        const target = getTargetSystemAndComponent(message)
        
        console.log(`[${currentTime}] First message: ${message.msg_name} (${msgid}), from: ${packet.header.sysid}-${packet.header.compid} ${target ? `to: ${target.targetSystem}-${target.targetComponent}` : ''}`);

        newMessageList[longKey] = true;
	}
    }

    //Overskriver data i datastore med ny melding
    datastore[key] = message;

    //Håndterer mottak av nyt PhotoCapture event
    if(key == 180){
        handlePhotoCapture(message);
    }


    //Sjekker om noen web socket clienter abonnerer på aktuell melding
    

    const hasSubscribers = clients.some(client =>
        client.readyState === WebSocket.OPEN &&
        client.subscriptions.has(String(key))
    );
    

    
    if (hasSubscribers) {
        const payload = JSON.stringify({
            msgid: key,
            sysid: packet.header.sysid,
            compid: packet.header.compid,
            message: replaceBigIntWithString(message)
        });
    
        // Now send to the subscribed clients
        clients.forEach(client => {
            if (
                client.readyState === WebSocket.OPEN &&
                client.subscriptions.has(String(key))
            ) {
                client.send(payload);
            }
        });
    }
    
    if(process.stdout.isTTY){
       prog();
    }	
})



function getTargetSystemAndComponent(message) {
    if ('targetSystem' in message && 'targetComponent' in message) {
        return { targetSystem: message.targetSystem, targetComponent: message.targetComponent };
    }
    return null; // Return null if the properties do not exist
}

function handlePhotoCapture(cameraFeedbackMessage) {


    // Get the current time of day
    const timestamp = new Date().toISOString();

    customFields = {
        dateTimeCaptureISO : convertTimestringToISO8601(datastore[2].timeUnixUsec)
    }

    // Assemble photoCapture event object
    const photoCaptureEvent = {
        timestamp : timestamp,
        CameraFeedbackMessage : cameraFeedbackMessage,
        GimbalOrientation : datastore[265],
        SystemTime : datastore[42],
        Custom : customFields  
    };

    // Perform any additional processing or logging
    // console.log('PhotoCapture event:', photoCaptureEvent);


    // You can store or send this event as needed
    db.insertPhotoCaptureEvent(photoCaptureEvent)
    .then(() => {
        console.log('PhotoCapture event inserted into the database.');
    })
    .catch(error => {
        console.error('Error inserting photoCapture event into the database:', error);
    });
}


//Counter functionality to notice incoming data. 
let iteration = 0;
let count = 0;
function prog() {
    if (iteration > 5 ) {
        process.stdout.write('*');
        iteration = 0;
        count++;
    }
    iteration += 1;
    if (count > 30) {
	
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        count = 0;
    }
    iteration += 1;
}


// Start the server
// const portNo = 3000;
const portNo = process.env.PORT || 3000; // Fallback to 3000 if not set

server.listen(portNo, () => {
    console.log(`Server and WebSocket listening on port ${portNo}`);
});

// app.listen(portNo, () => {
//     console.log(`Server is listening on port ${portNo}`);
// });


// Event handler for errors
udpSocket.on('error', (err) => {
    console.error(`UDP socket error:\n${err.stack}`);
});

// Event handler for when the socket is ready
udpSocket.on('listening', () => {
    const address = udpSocket.address();
    console.log(`UDP socket listening on ${address.address}:${address.port}`);
});


// app.get('/api/cleardatabase', (req,res) => {
    
//     database.clearDatabase();
//     res.send("Database is cleared")
// });



function sendUavionixAdsbOutCfg({
    udpSocket,
    targetIP = '127.0.0.1',
    targetPort = 14550,
    systemId = 1,
    componentId = 1,
    ICAO = 123456789,
    callsign = 'TEST1234',
    emitterType = 1, // e.g., MAV_ADSB_EMITTER_TYPE_LIGHT
    aircraftSize = 1,
    gpsOffsetLat = 0,
    gpsOffsetLon = 0,
    stallSpeed = 20,
    capabilities = 0
}) {
    const message = new uavionix.UavionixAdsbOutCfg(
        ICAO,
        callsign,
        emitterType,
        aircraftSize,
        gpsOffsetLat,
        gpsOffsetLon,
        stallSpeed,
        capabilities
    );

    // Wrap the message in a MavLink frame
    const packet = message.pack(systemId, componentId);

    // Serialize to Buffer and send via UDP
    const buffer = Buffer.from(packet.buffer);
    udpSocket.send(buffer, 0, buffer.length, targetPort, targetIP, (err) => {
        if (err) {
            console.error('Failed to send UAVIONIX_ADSB_OUT_CFG:', err);
        } else {
            console.log(`UAVIONIX_ADSB_OUT_CFG message sent to ${targetIP}:${targetPort}`);
        }
    });
}


