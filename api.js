const express = require('express');
const router = express.Router();
const database = require('./database');
const { convertTimestringToISO8601, replaceBigIntWithString } = require('./utils');


const { initializeDatabase } = require('./database');

const db = initializeDatabase();

// const db = database();

// Get datastore reference from server.js (will be set when server.js loads)
let datastore = {};

function setDatastore(ds) {
    datastore = ds;
}

router.get('/', (req, res) => {
    res.json({
        message: 'ArduPhotoLogger API',
        version: '1.0.0',
        endpoints: [
            {
                method: 'GET',
                path: '/api',
                description: 'API overview (this page)'
            },
            {
                method: 'GET',
                path: '/api/config',
                description: 'Get current configuration'
            },
            {
                method: 'POST',
                path: '/api/config/reload',
                description: 'Reload configuration from config.conf'
            },
            {
                method: 'GET',
                path: '/api/photocaptures',
                description: 'Get all photo captures as JSON (sorted newest first)'
            },
            {
                method: 'GET',
                path: '/api/photocapturelist',
                description: 'Get photo captures as CSV list'
            },
            {
                method: 'GET',
                path: '/api/photocapturelistgeojson',
                description: 'Get photo captures as GeoJSON'
            },
            {
                method: 'GET',
                path: '/api/datastore',
                description: 'Get datastore statistics'
            },
            {
                method: 'GET',
                path: '/api/datastore/:index',
                description: 'Get specific datastore entry by index'
            },
            {
                method: 'GET',
                path: '/api/datastore/all',
                description: 'Get all datastore entries'
            },
            {
                method: 'GET',
                path: '/api/sync/status',
                description: 'Get PostgreSQL sync status and statistics'
            },
            {
                method: 'POST',
                path: '/api/sync/force',
                description: 'Force an immediate sync to PostgreSQL'
            },
            {
                method: 'GET',
                path: '/api/sync/pending',
                description: 'Get count of pending unsynced records'
            },
            {
                method: 'POST',
                path: '/api/cleardatabase',
                description: 'Clear all database records (requires confirmation)',
                body: { confirm: 'DELETE_ALL_DATA' }
            }
        ]
    });
});

router.get('/config', (req, res) => {
    const config = require('./config');
    res.json(config.get());
});

router.post('/config/reload', (req, res) => {
    const config = require('./config');
    const reloadedConfig = config.reload();
    res.json({ message: 'Configuration reloaded', config: reloadedConfig });
});

// Dangerous operation - requires POST with confirmation token
router.post('/cleardatabase', (req, res) => {
    const { confirm } = req.body;
    
    if (confirm !== 'DELETE_ALL_DATA') {
        return res.status(400).json({ 
            error: 'Confirmation required',
            message: 'Send { "confirm": "DELETE_ALL_DATA" } in request body to proceed'
        });
    }
    
    database.clearDatabase();
    res.json({ 
        success: true,
        message: 'Database cleared',
        timestamp: new Date().toISOString()
    });
});

// Get all photo captures as JSON (sorted newest first)
router.get('/photocaptures', (req, res) => {
    db.find({ timestamp: { $exists: true } })
        .sort({ timestamp: -1 })
        .exec((err, records) => {
            if (err) return res.status(500).json({ error: 'Internal server error' });
            
            const formattedRecords = records.map(record => ({
                id: record._id,
                timestamp: record.timestamp,
                captureTime: record.Custom?.dateTimeCaptureISO,
                lat: record.CameraFeedbackMessage?.lat / 1e7,
                lng: record.CameraFeedbackMessage?.lng / 1e7,
                altMsl: record.CameraFeedbackMessage?.altMsl,
                altRel: record.CameraFeedbackMessage?.altRel,
                pitch: record.GimbalOrientation?.pitch,
                roll: record.GimbalOrientation?.roll,
                yaw: record.GimbalOrientation?.yaw,
                yawAbsolute: record.GimbalOrientation?.yawAbsolute,
                hostname: record.hostname,
                synced: record.synced,
                syncAttempts: record.syncAttempts
            }));
            
            res.json(formattedRecords);
        });
});



router.get('/photocapturelist', (req, res) => {
    db.find({ timestamp: { $exists: true } }).sort({ 'Custom.dateTimeCaptureISO': 1 }).exec((err, records) => {
        if (err) return res.status(500).json({ error: 'Internal server error' });

        const fields = [
            'Custom.dateTimeCaptureISO',
            'CameraFeedbackMessage.lat',
            'CameraFeedbackMessage.lng',
            'CameraFeedbackMessage.altMsl',
            'CameraFeedbackMessage.altRel',
            'GimbalOrientation.pitch',
            'GimbalOrientation.roll',
            'GimbalOrientation.yaw',
            'GimbalOrientation.yawAbsolute'
        ];

        const fieldNames = fields.join(',') + '\n';
        const csvList = records.map(record =>
            fields.map(field => {
                const parts = field.split('.');
                let value = record;
                for (const part of parts) {
                    if (value && value.hasOwnProperty(part)) {
                        value = value[part];
                    } else {
                        value = null;
                        break;
                    }
                }
                return value;
            }).join(',')
        ).join('\n');

        if (req.query.dl === 'true') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="photocapture_list.csv"');
        } else {
            res.setHeader('Content-Type', 'text/plain');
        }

        res.send(fieldNames + csvList);
    });
});

function isValidRecord(record) {
    return (
        record?.CameraFeedbackMessage?.lat != null &&
        record?.CameraFeedbackMessage?.lng != null &&
        record?.CameraFeedbackMessage?.altMsl != null &&
        record?.GimbalOrientation?.pitch != null &&
        record?.GimbalOrientation?.roll != null &&
        record?.GimbalOrientation?.yaw != null &&
        record?.GimbalOrientation?.yawAbsolute != null &&
        record?.Custom?.dateTimeCaptureISO
    );
}


router.get('/photocapturelistgeojson', (req, res) => {

    db.find({ timestamp: { $exists: true } }).sort({ 'Custom.dateTimeCaptureISO': 1 }).exec((err, records) => {
        if (err) return res.status(500).json({ error: 'Internal server error' });



        // db.find({ timestamp: { $exists: true } }, (err, records) => {
        //     if (err) return res.status(500).json({ error: 'Internal server error' });

        const featureCollection = {
            type: 'FeatureCollection',
            features: []
        };

        records.forEach((record, index) => {
            try {
                // Basic field presence validation
                const cf = record.CameraFeedbackMessage;
                const go = record.GimbalOrientation;
                const custom = record.Custom;
        
                if (
                    !cf || !go || !custom ||
                    cf.lat == null || cf.lng == null ||
                    cf.altMsl == null || cf.altRel == null ||
                    go.pitch == null || go.roll == null || go.yaw == null || go.yawAbsolute == null ||
                    !custom.dateTimeCaptureISO
                ) {
                    console.warn(`Skipping record at index ${index} due to missing fields.`);
                    return;
                }
        
                // Parse and convert fields
                const lat = parseFloat(cf.lat) / 1e7;
                const lng = parseFloat(cf.lng) / 1e7;
        
                const properties = {
                    lat,
                    lng,
                    altMsl: parseFloat(cf.altMsl),
                    altRel: parseFloat(cf.altRel),
                    pitch: parseFloat(go.pitch),
                    roll: parseFloat(go.roll),
                    yaw: parseFloat(go.yaw),
                    yawAbsolute: parseFloat(go.yawAbsolute),
                    timestamp:  custom.dateTimeCaptureISO.replace("T", " ").replace("Z", ""),
                    bootTime: parseInt(go.timeBootMs)
                };
        
                const geometry = {
                    type: 'Point',
                    coordinates: [lng, lat]
                };
        
                featureCollection.features.push({ type: 'Feature', properties, geometry });
        
            } catch (error) {
                console.error(`Error processing record at index ${index}:`, error.message);
            }
        });

        if (req.query.dl === 'true') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="photocapture_list.geojson"');
        } else {
            res.setHeader('Content-Type', 'application/json');
        }

        res.json(featureCollection);
        // res.json("Hei")
    });
});

router.get('/api/datastore/:index', (req, res) => {
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

router.get('/datastore', (req, res) => {
    res.json(replaceBigIntWithString(datastore));
});

router.get('/api/datastore/all', (req, res) => {
    res.json(replaceBigIntWithString(datastore))
});

// Sync status endpoint
router.get('/sync/status', (req, res) => {
    const syncWorker = req.app.get('syncWorker');
    if (!syncWorker) {
        return res.status(503).json({ error: 'Sync worker not initialized' });
    }
    res.json(syncWorker.getStats());
});

// Force sync endpoint
router.post('/sync/force', async (req, res) => {
    const syncWorker = req.app.get('syncWorker');
    if (!syncWorker) {
        return res.status(503).json({ error: 'Sync worker not initialized' });
    }
    try {
        await syncWorker.forceSyncNow();
        res.json({ message: 'Sync triggered successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get unsynced count
router.get('/sync/pending', async (req, res) => {
    try {
        const unsynced = await db.getUnsyncedEvents(1000);
        res.json({ 
            count: unsynced.length,
            events: unsynced.map(e => ({
                id: e._id,
                timestamp: e.timestamp,
                attempts: e.syncAttempts || 0,
                lastAttempt: e.lastSyncAttempt
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router, setDatastore };