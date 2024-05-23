// Import NeDB
const Datastore = require('nedb');
const fs = require('fs');

// Define the configuration for the database
const dbConfig = {
    filename: 'database.db', // Change the path as needed
    autoload: true
};

// Create and export a function to initialize the database
module.exports = () => {
    const db = new Datastore(dbConfig);

    // Function to insert a photoCapture event into the database
    function insertPhotoCaptureEvent(photoCaptureEvent) {
        return new Promise((resolve, reject) => {
            // Insert the photoCapture event into the database
            db.insert(photoCaptureEvent, (err, newEvent) => {
                if (err) {
                    reject(err);
                } else {
                    // Resolve the promise with the inserted photoCapture event
                    resolve(newEvent);
                }
            });
        });
    }

    // Attach the insertPhotoCaptureEvent function to the database instance
    db.insertPhotoCaptureEvent = insertPhotoCaptureEvent;

    return db;
};

// Function to clear the database on startup
module.exports.clearDatabase = () => {
    // Check if the database file exists
    if (fs.existsSync(dbConfig.filename)) {
        // If the database file exists, delete it
        fs.unlinkSync(dbConfig.filename);
        console.log('Database cleared.');
    } else {
        console.log('No existing database found.');
    }
};


