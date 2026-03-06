const dgram = require('dgram');
const { Readable } = require('stream');
const { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkPacketRegistry, minimal, common, ardupilotmega, uavionix, send } = require('node-mavlink');
const express = require('express');
const { Console } = require('console');
const fs = require('fs');
// const os = require('os');

const WebSocket = require('ws');
const http = require('http');

const cors = require('cors');

const config = require('./config');
const database = require('./database');
const SyncWorker = require('./sync-worker');

const app = express();

const timeOfTakeOff = null;

let datastore = {};
let newMessageList = {};
let syncWorker = null;

const { router, setDatastore } = require('./api');

// Pass datastore reference to API
setDatastore(datastore);

app.use(express.json());
app.use(cors());
app.use('/api', router);

const {
    convertTimestringToISO8601,
    getLocalIP,
    getHostname,
    replaceBigIntWithString
} = require('./utils')

// database.clearDatabase();

const db = database.initializeDatabase();

// Initialize sync worker
syncWorker = new SyncWorker(db, {
    syncIntervalMs: config.get('sync', 'sync_interval_ms') || 30000,
    batchSize: config.get('sync', 'sync_batch_size') || 50,
    maxRetries: config.get('sync', 'sync_max_retries') || 5,
    cleanupOlderThanHours: config.get('sync', 'sync_cleanup_hours') || 24,
    enabled: config.get('sync', 'sync_enabled') !== 'false' && config.get('sync', 'sync_enabled') !== false
});

// Make syncWorker available to routes
app.set('syncWorker', syncWorker);

console.log('=== ArduPhotoLogger Configuration ===');
console.log('Server Port:', config.get('server', 'port'));
console.log('MAVLink Port:', config.get('mavlink', 'port'));
console.log('WebSocket Enabled:', config.get('server', 'websocket_enabled'));
console.log('Photo Capture Enabled:', config.get('features', 'photo_capture'));
console.log('Database Logging Enabled:', config.get('features', 'database_logging'));
console.log('PostgreSQL Sync Enabled:', config.get('sync', 'sync_enabled'));
console.log('=====================================\n');

console.log(`My IP is ${getLocalIP()}`);

const server = http.createServer(app);
const wss = config.get('server', 'websocket_enabled') ? new WebSocket.Server({ server }) : null;
//Web socket clients
let clients = [];

// Create a UDP socket
const udpSocket = dgram.createSocket('udp4');

// Listen for messages assigned port
udpSocket.bind(config.get('mavlink', 'port'), config.get('mavlink', 'host'));

//Web sockets stuff..
if (wss) {
    wss.on('connection', (ws) => {
        ws.subscriptions = new Set();

        clients.push(ws);
        // console.log('Client connected');

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.subscribe && Array.isArray(data.subscribe)) {
                    ws.subscriptions = new Set(data.subscribe.map(String));
                    // console.log(`Client subscriptions updated: ${[...ws.subscriptions].join(', ')}`);
                }
            } catch (e) {
                console.error('Invalid message from client:', message);
            }
        });

        ws.on('close', () => {
            clients = clients.filter(client => client !== ws);
            // console.log('Client disconnected');
        });
    });
}

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
	
        // const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false });
        // const target = getTargetSystemAndComponent(message)
        // console.log(`[${currentTime}] First message: ${message.msg_name} (${msgid}), from: ${packet.header.sysid}-${packet.header.compid} ${target ? `to: ${target.targetSystem}-${target.targetComponent}` : ''}`);

        newMessageList[longKey] = true;
	}
    }

    //Overskriver data i datastore med ny melding
    datastore[key] = message;

    //Håndterer mottak av nyt PhotoCapture event
    if(key == 180 && config.get('features', 'photo_capture')){
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
    
    // Removed prog() call - no more asterisk spam
    // if(process.stdout.isTTY){
    //    prog();
    // }	
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
        Custom : customFields,
        hostname : getHostname()
    };

    // Perform any additional processing or logging
    // console.log('PhotoCapture event:', photoCaptureEvent);


    // You can store or send this event as needed
    db.insertPhotoCaptureEvent(photoCaptureEvent)
    .then(() => {
        const lat = (cameraFeedbackMessage.lat / 1e7).toFixed(6);
        const lng = (cameraFeedbackMessage.lng / 1e7).toFixed(6);
        const alt = cameraFeedbackMessage.altRel?.toFixed(1) || 'N/A';
        console.log(`📷 Photo captured at ${lat}, ${lng} | Alt: ${alt}m | ${customFields.dateTimeCaptureISO}`);
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
const portNo = config.get('server', 'port');

server.listen(portNo, async () => {
    console.log(`Server and WebSocket listening on port ${portNo}`);
    
    // Start sync worker
    try {
        await syncWorker.start();
    } catch (err) {
        console.error('Failed to start sync worker:', err.message);
    }
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

// Graceful shutdown handler
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await shutdown();
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    await shutdown();
});

async function shutdown() {
    try {
        // Stop sync worker
        if (syncWorker) {
            await syncWorker.stop();
        }
        
        // Close WebSocket server
        if (wss) {
            wss.clients.forEach(client => {
                client.close();
            });
            wss.close(() => {
                console.log('WebSocket server closed');
            });
        }
        
        // Close UDP socket
        udpSocket.close(() => {
            console.log('UDP socket closed');
        });
        
        // Close HTTP server
        server.close(() => {
            console.log('HTTP server closed');
        });
        
        // Force exit after 5 seconds if graceful shutdown fails
        setTimeout(() => {
            console.log('Forcing shutdown...');
            process.exit(0);
        }, 5000);
        
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
}


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


