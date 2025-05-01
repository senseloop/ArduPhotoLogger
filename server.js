const dgram = require('dgram');
const { Readable } = require('stream');
const { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkPacketRegistry, minimal, common, ardupilotmega, uavionix } = require('node-mavlink');
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

app.use('/api', router);
app.use(express.json());
app.use(cors());

const {
    convertTimestringToISO8601,
    getLocalIP,
    replaceBigIntWithString
} = require('./utils')

database.clearDatabase();

const db = database.initializeDatabase();

// database.clearDatabase();


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

    //Håndterer mottak av generator status
    // if(key == 373){

    // }

    //prog() printer stjerner for å vise at prosessen fortsatt går. Ny stjerne for ca hver 5. melding 

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

app.get('/api/datastore/:index', (req, res) => {
    const index = req.params.index; // Get the index from the request parameters

    // Validate the index is a number
    if (isNaN(index)) {
        return res.status(400).json({ error: 'Index must be a number' });
    }

    // Check if the specified index exists in the datastore
    if (!datastore.hasOwnProperty(index)) {
        return res.status(404).json({ error: `No data found at index ${index}` });
    }

    // Retrieve the data at the specified index
    const data = datastore[index];

    // Send the data as the response

    res.json(replaceBigIntWithString(data));
});

app.get('/api/datastore', (req, res) => {
    res.json(replaceBigIntWithString(datastore));
});

app.get('/api/datastore/all', (req, res) => {
    res.json(replaceBigIntWithString(datastore))
});

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


// Define an API endpoint to return a comma-separated list of PhotoCapture event records with selected fields
// app.get('/api/photocapturelist', (req, res) => {
//     // Fetch PhotoCapture event records from the database
//     db.find({ timestamp: { $exists: true } }).sort({ 'SystemTime.timeBootMs': 1 }).exec((err, records) => {
//         if (err) {
//             console.error('Error fetching PhotoCapture events:', err);
//             return res.status(500).json({ error: 'Internal server error' });
//         }

//         // Define the fields you want to include in the list
//         const fields = ['SystemTime.timeBootMs', 'CameraFeedbackMessage.lat', 'CameraFeedbackMessage.lng', 'CameraFeedbackMessage.altMsl', 'CameraFeedbackMessage.altRel', 'GimbalOrientation.pitch', 'GimbalOrientation.roll', 'GimbalOrientation.yaw', 'GimbalOrientation.yawAbsolute']; // Adjust fields as needed

//         // record.SystemTime.timeBootMs
//         // Format the field names as the first line of the CSV
//         const fieldNames = fields.join(',') + '\n';

//         // Format the records into a comma-separated list with selected fields
//         const csvList = records.map(record => fields.map(field => {
//             const fieldNames = field.split('.');
//             let value = record;
//             for (const fieldName of fieldNames) {
//                 if (value && value.hasOwnProperty(fieldName)) {
//                     value = value[fieldName];
//                 } else {
//                     value = null;
//                     break;
//                 }
//             }
//             return value;
//         }).join(',')).join('\n');

//         // Check if the dl query parameter is present
//         const download = req.query.dl === 'true';

//         // Set response headers based on the value of the download parameter
//         if (download) {
//             res.setHeader('Content-Type', 'text/csv');
//             res.setHeader('Content-Disposition', 'attachment; filename="photocapture_list.csv"');
//         } else {
//             res.setHeader('Content-Type', 'text/plain'); // Display as plain text if not downloading
//         }

//         // Send the formatted field names followed by the CSV list as the response
//         res.send(fieldNames + csvList);
//     });
// });

// app.get('/api/photocapturelistgeojson', (req, res) => {
//     // Fetch PhotoCapture event records from the database
//     db.find({ timestamp: { $exists: true } }, (err, records) => {
//         if (err) {
//             console.error('Error fetching PhotoCapture events:', err);
//             return res.status(500).json({ error: 'Internal server error' });
//         }

//         // Define the GeoJSON feature collection
//         const featureCollection = {
//             type: 'FeatureCollection',
//             features: []
//         };

//         // Convert each record to a GeoJSON feature
//         records.forEach(record => {
//             // Parse latitude and longitude values as decimal degrees
//             const lat = parseFloat(record.CameraFeedbackMessage.lat)/10000000;
//             const lng = parseFloat(record.CameraFeedbackMessage.lng)/10000000;
//             // Your timestamp with nanoseconds
//             let unixTimeNanoseconds = 1715766853676767n;

//             // Convert nanoseconds to milliseconds (BigInt to BigInt)
//             let unixTimeMillisecondsBigInt = unixTimeNanoseconds / 1000000n;

//             // Convert BigInt milliseconds to Number
//             let unixTimeMilliseconds = Number(unixTimeMillisecondsBigInt);

//             // Create a Date object from the milliseconds
//             let date = new Date(unixTimeMilliseconds);

//             // Print the date to the console in ISO 8601 format
//             console.log(date.toISOString());

//             // Define properties for the feature
//             const properties = {
//                 lat: lat,
//                 lng: lng,
//                 altMsl: parseFloat(record.CameraFeedbackMessage.altMsl),
//                 altRel: parseFloat(record.CameraFeedbackMessage.altRel),
//                 pitch: parseFloat(record.GimbalOrientation.pitch),
//                 roll: parseFloat(record.GimbalOrientation.roll),
//                 yaw: parseFloat(record.GimbalOrientation.yaw),
//                 yawAbsolute: parseFloat(record.GimbalOrientation.yawAbsolute),
//                 systemTime: parseFloat(record.SystemTime.timeBootMs),
//                 captureTime: record.Custom.dateTimeCaptureISO
//                 // time: record.customFields.dateTimeCaptureISO
//             };

//             // Define geometry for the feature
//             const geometry = {
//                 type: 'Point',
//                 coordinates: [lng, lat]
//             };

//             // Create the GeoJSON feature
//             const feature = {
//                 type: 'Feature',
//                 properties: properties,
//                 geometry: geometry
//             };

//             // Add the feature to the feature collection
//             featureCollection.features.push(feature);
//         });

//         // Check if the dl query parameter is present and set to true
//         const download = req.query.dl === 'true';

//         // Set response headers based on the value of the download parameter
//         if (download) {
//             res.setHeader('Content-Type', 'application/json');
//             res.setHeader('Content-Disposition', 'attachment; filename="photocapture_list.geojson"');
//         } else {
//             res.setHeader('Content-Type', 'application/json');
//         }

//         // Send the GeoJSON feature collection as the response
//         res.json(featureCollection);
//     });
// });
