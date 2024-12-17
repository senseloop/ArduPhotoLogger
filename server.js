const dgram = require('dgram');
const { Readable } = require('stream');
const { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkPacketRegistry, minimal, common, ardupilotmega } = require('node-mavlink');
const express = require('express');
const { Console } = require('console');
const fs = require('fs');

const cors = require('cors');

const database = require('./database');

const app = express();
app.use(express.json());
app.use(cors());



const db = database();
database.clearDatabase();

let datastore = {};

// Create a UDP socket
const udpSocket = dgram.createSocket('udp4');

// Listen for messages on port 14550
udpSocket.bind(14555, '0.0.0.0');

// Custom Readable stream that listens for messages from UDP socket
class UDPReadable extends Readable {
    constructor(socket, options) {
        super(options);
        this.socket = socket;
        this.socket.on('message', this.handleMessage.bind(this));
    }

    handleMessage(msg, rinfo) {
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
}

function convertTimestringToISO8601(input) {
     // Ensure the input is a BigInt
     let microsecondsBigInt = input;

     // If the input ends with 'n', convert it to a BigInt by slicing the 'n' off
     if (typeof input === 'string' && input.endsWith('n')) {
         microsecondsBigInt = BigInt(input.slice(0, -1));
     }
 
     // Convert microseconds BigInt to milliseconds BigInt
     const millisecondsBigInt = microsecondsBigInt / 1000n;
 
     // Convert milliseconds BigInt to number for Date object (safe if within the range of Number)
     const milliseconds = Number(millisecondsBigInt);
 
     // Create a Date object
     const date = new Date(milliseconds);
 
     // Return the ISO 8601 formatted string
     return date.toISOString();
}


//console.log(REGISTRY);
// port.on('data', packet => {
//     console.log('Raw packet:', packet.header.msgid);
// })


//const subscribedMessages = [110, 111, 87, 11030, 147, 22, 193, 136, 168, 178, 164, 24, 137, 29, 129, 116, 27, 65, 36, 74, 42, 62, 152, 125, 30, 1130, 163, 241, 163, 2, 0, 1, 11, 255]
//const subscribedMessages = [] 


const getData = (packet) => {
    if(!REGISTRY.hasOwnProperty(packet.header.msgid)){
        console.log("Warning: Unknown message ID");
    }
    //console.log(packet);
    
    const clazz = REGISTRY[packet.header.msgid]

    const result = packet.protocol.data(packet.payload, clazz);
    result.msg_name = clazz.MSG_NAME;
    //result.msg_name = packet.header.msgid;
    result[clazz.MSG_NAME] = packet.protocol.data(packet.payload, clazz);
    return result;

    //return {clazz: packet.protocol.data(packet.payload, clazz)};
}



// RANGEFINDER : 173
// LOCAL_POSITION_NED : 32
// POSITION_TARGET_GLOBAL_INT : 87
// ATTITUDE: 30
// GLOBAL_POSITION_INT : 33
// MOUNT_ORIENTATION : 265
// MOUNT_STATUS : 158


port.on('data', packet => {
    const key = packet.header.msgid;
    const message = getData(packet);

    //Debug
    if (!datastore.hasOwnProperty(key)) {
        console.log("New message type ", message.msg_name , " (id: ", packet.header.msgid, ")");
    }
    datastore[key] = message;
    if(key == 180){
        handlePhotoCapture(message);
        //console.log(datastore[265]);
    }
    prog();
})

function handlePhotoCapture(cameraFeedbackMessage) {

    // Select additional messages from the datastore
    // const selectedMessages = {
    //     // Example: Add selected messages from datastore
    //     // message33: datastore[33],
    //     // message32: datastore[32],
    //     // Add more messages as needed
    // };

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
    console.log('PhotoCapture event:', photoCaptureEvent);


    // You can store or send this event as needed
    db.insertPhotoCaptureEvent(photoCaptureEvent)
    .then(() => {
        console.log('PhotoCapture event inserted into the database.');
    })
    .catch(error => {
        console.error('Error inserting photoCapture event into the database:', error);
    });
}


//Counter functionality so notice incoming data. 
let iteration = 0;
let count = 0;
function prog() {
    if (iteration === 50) {
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
const portNo = 3000;

app.listen(portNo, () => {
    console.log(`Server is listening on port ${portNo}`);
});


// Event handler for errors
udpSocket.on('error', (err) => {
    console.error(`UDP socket error:\n${err.stack}`);
});

// Event handler for when the socket is ready
udpSocket.on('listening', () => {
    const address = udpSocket.address();
    console.log(`UDP socket listening on ${address.address}:${address.port}`);
});


app.get('/api/cleardatabase', (req,res) => {
    
    database.clearDatabase();
    res.send("Database is cleared")
});

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
    res.json(data);
});

// Define an API endpoint to return a comma-separated list of PhotoCapture event records with selected fields
app.get('/api/photocapturelist', (req, res) => {
    // Fetch PhotoCapture event records from the database
    db.find({ timestamp: { $exists: true } }).sort({ 'SystemTime.timeBootMs': 1 }).exec((err, records) => {
        if (err) {
            console.error('Error fetching PhotoCapture events:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }

        // Define the fields you want to include in the list
        const fields = ['SystemTime.timeBootMs', 'CameraFeedbackMessage.lat', 'CameraFeedbackMessage.lng', 'CameraFeedbackMessage.altMsl', 'CameraFeedbackMessage.altRel', 'GimbalOrientation.pitch', 'GimbalOrientation.roll', 'GimbalOrientation.yaw', 'GimbalOrientation.yawAbsolute']; // Adjust fields as needed

        // record.SystemTime.timeBootMs
        // Format the field names as the first line of the CSV
        const fieldNames = fields.join(',') + '\n';

        // Format the records into a comma-separated list with selected fields
        const csvList = records.map(record => fields.map(field => {
            const fieldNames = field.split('.');
            let value = record;
            for (const fieldName of fieldNames) {
                if (value && value.hasOwnProperty(fieldName)) {
                    value = value[fieldName];
                } else {
                    value = null;
                    break;
                }
            }
            return value;
        }).join(',')).join('\n');

        // Check if the dl query parameter is present
        const download = req.query.dl === 'true';

        // Set response headers based on the value of the download parameter
        if (download) {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="photocapture_list.csv"');
        } else {
            res.setHeader('Content-Type', 'text/plain'); // Display as plain text if not downloading
        }

        // Send the formatted field names followed by the CSV list as the response
        res.send(fieldNames + csvList);
    });
});

app.get('/api/photocapturelistgeojson', (req, res) => {
    // Fetch PhotoCapture event records from the database
    db.find({ timestamp: { $exists: true } }, (err, records) => {
        if (err) {
            console.error('Error fetching PhotoCapture events:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }

        // Define the GeoJSON feature collection
        const featureCollection = {
            type: 'FeatureCollection',
            features: []
        };

        // Convert each record to a GeoJSON feature
        records.forEach(record => {
            // Parse latitude and longitude values as decimal degrees
            const lat = parseFloat(record.CameraFeedbackMessage.lat)/10000000;
            const lng = parseFloat(record.CameraFeedbackMessage.lng)/10000000;
            // Your timestamp with nanoseconds
            let unixTimeNanoseconds = 1715766853676767n;

            // Convert nanoseconds to milliseconds (BigInt to BigInt)
            let unixTimeMillisecondsBigInt = unixTimeNanoseconds / 1000000n;

            // Convert BigInt milliseconds to Number
            let unixTimeMilliseconds = Number(unixTimeMillisecondsBigInt);

            // Create a Date object from the milliseconds
            let date = new Date(unixTimeMilliseconds);

            // Print the date to the console in ISO 8601 format
            console.log(date.toISOString());

            // Define properties for the feature
            const properties = {
                lat: lat,
                lng: lng,
                altMsl: parseFloat(record.CameraFeedbackMessage.altMsl),
                altRel: parseFloat(record.CameraFeedbackMessage.altRel),
                pitch: parseFloat(record.GimbalOrientation.pitch),
                roll: parseFloat(record.GimbalOrientation.roll),
                yaw: parseFloat(record.GimbalOrientation.yaw),
                yawAbsolute: parseFloat(record.GimbalOrientation.yawAbsolute),
                systemTime: parseFloat(record.SystemTime.timeBootMs),
                captureTime: record.Custom.dateTimeCaptureISO
                // time: record.customFields.dateTimeCaptureISO
            };

            // Define geometry for the feature
            const geometry = {
                type: 'Point',
                coordinates: [lng, lat]
            };

            // Create the GeoJSON feature
            const feature = {
                type: 'Feature',
                properties: properties,
                geometry: geometry
            };

            // Add the feature to the feature collection
            featureCollection.features.push(feature);
        });

        // Check if the dl query parameter is present and set to true
        const download = req.query.dl === 'true';

        // Set response headers based on the value of the download parameter
        if (download) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="photocapture_list.geojson"');
        } else {
            res.setHeader('Content-Type', 'application/json');
        }

        // Send the GeoJSON feature collection as the response
        res.json(featureCollection);
    });
});
