# ArduPhotoLogger Client

React + Leaflet web client for viewing photo capture locations and data.

## Setup

1. Install dependencies:
```bash
cd client
npm install
```

2. Start the development server:
```bash
npm start
```

The client will run on http://localhost:3001 and proxy API requests to the main server on port 3000.

## Features

- **Interactive Map**: View all photo capture locations on an OpenStreetMap
- **Photo List**: Sidebar showing all captures sorted by newest first
- **Important Columns**:
  - Timestamp (when photo was captured)
  - GPS coordinates (lat/lng)
  - Altitude (MSL and relative)
  - Gimbal orientation (pitch, roll, yaw)
  - Hostname (device identifier)
  - Sync status (synced or pending)
- **Click to Focus**: Click any photo in the list to center the map
- **Auto-refresh**: Updates every 10 seconds
- **Responsive**: Works on desktop and tablet

## Build for Production

```bash
npm run build
```

This creates an optimized production build in the `build/` directory.
