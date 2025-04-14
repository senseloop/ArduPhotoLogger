const os = require('os');

module.exports = {
      convertTimestringToISO8601,
      getLocalIP,
      replaceBigIntWithString
    };
    

function getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'Unknown';
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

function replaceBigIntWithString(obj) {
    if (typeof obj === 'bigint') {
        return obj.toString(); // or use Number(obj) if safe
    } else if (Array.isArray(obj)) {
        return obj.map(replaceBigIntWithString);
    } else if (obj !== null && typeof obj === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = replaceBigIntWithString(value);
        }
        return result;
    }
    return obj;
}