const express = require('express');
const router = express.Router();
const database = require('./database');
const { convertTimestringToISO8601 } = require('./utils');

const db = database();

router.get('/'), (req, res) => {
    res.send("Assa du er digg azz");
}

router.get('/cleardatabase', (req, res) => {
    database.clearDatabase();
    res.send('Database is cleared');
});


router.get('/photocapturelist', (req, res) => {
    db.find({ timestamp: { $exists: true } }).sort({ 'SystemTime.timeBootMs': 1 }).exec((err, records) => {
        if (err) return res.status(500).json({ error: 'Internal server error' });

        const fields = [
            'SystemTime.timeBootMs',
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


router.get('/photocapturelistgeojson', (req, res) => {
    db.find({ timestamp: { $exists: true } }, (err, records) => {
        if (err) return res.status(500).json({ error: 'Internal server error' });

        const featureCollection = {
            type: 'FeatureCollection',
            features: []
        };

        records.forEach(record => {
            const lat = parseFloat(record.CameraFeedbackMessage.lat) / 1e7;
            const lng = parseFloat(record.CameraFeedbackMessage.lng) / 1e7;

            const properties = {
                lat,
                lng,
                altMsl: parseFloat(record.CameraFeedbackMessage.altMsl),
                altRel: parseFloat(record.CameraFeedbackMessage.altRel),
                pitch: parseFloat(record.GimbalOrientation.pitch),
                roll: parseFloat(record.GimbalOrientation.roll),
                yaw: parseFloat(record.GimbalOrientation.yaw),
                yawAbsolute: parseFloat(record.GimbalOrientation.yawAbsolute),
                systemTime: parseFloat(record.SystemTime.timeBootMs),
                captureTime: record.Custom.dateTimeCaptureISO
            };

            const geometry = {
                type: 'Point',
                coordinates: [lng, lat]
            };

            featureCollection.features.push({ type: 'Feature', properties, geometry });
        });

        if (req.query.dl === 'true') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="photocapture_list.geojson"');
        } else {
            res.setHeader('Content-Type', 'application/json');
        }

        res.json(featureCollection);
    });
});


module.exports.router = router;