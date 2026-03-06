import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import axios from 'axios';
import 'leaflet/dist/leaflet.css';
import './App.css';

// Fix for default marker icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

// Custom icons for selected and unselected markers
const defaultIcon = new L.Icon({
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const selectedIcon = new L.Icon({
  iconUrl: 'data:image/svg+xml;base64,' + btoa(`
    <svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41">
      <path fill="#3498db" stroke="#2c3e50" stroke-width="2" d="M12.5 0C5.6 0 0 5.6 0 12.5c0 8.4 12.5 28.5 12.5 28.5S25 20.9 25 12.5C25 5.6 19.4 0 12.5 0z"/>
      <circle cx="12.5" cy="12.5" r="6" fill="white"/>
    </svg>
  `),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

// Component to update map view
function MapUpdater({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.setView(center, zoom);
    }
  }, [center, zoom, map]);
  return null;
}

function App() {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [mapCenter, setMapCenter] = useState([59.95, 10.78]);
  const [mapZoom, setMapZoom] = useState(13);
  const [autoPan, setAutoPan] = useState(true);
  const [lastPhotoId, setLastPhotoId] = useState(null);

  useEffect(() => {
    fetchPhotos();
    // Refresh every 10 seconds
    const interval = setInterval(fetchPhotos, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchPhotos = async () => {
    try {
      const response = await axios.get('/api/photocaptures');
      setPhotos(response.data);
      setLoading(false);
      
      // Auto-pan to latest photo if enabled and there's a new photo
      if (autoPan && response.data.length > 0) {
        const latestPhoto = response.data[0]; // Already sorted newest first
        
        // Check if this is a new photo (different from last known)
        if (latestPhoto.id !== lastPhotoId) {
          if (latestPhoto.lat && latestPhoto.lng) {
            setMapCenter([latestPhoto.lat, latestPhoto.lng]);
            setMapZoom(16);
            setSelectedPhoto(latestPhoto);
          }
          setLastPhotoId(latestPhoto.id);
        }
      } else if (response.data.length > 0 && !selectedPhoto && !lastPhotoId) {
        // Initial load - set map center to first photo
        const firstPhoto = response.data[0];
        if (firstPhoto.lat && firstPhoto.lng) {
          setMapCenter([firstPhoto.lat, firstPhoto.lng]);
          setLastPhotoId(firstPhoto.id);
        }
      }
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handlePhotoClick = (photo) => {
    setSelectedPhoto(photo);
    setAutoPan(false); // Disable auto-pan when user manually selects a photo
    if (photo.lat && photo.lng) {
      setMapCenter([photo.lat, photo.lng]);
      setMapZoom(16);
    }
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const syncedCount = photos.filter(p => p.synced).length;

  return (
    <div className="app-container">
      <div className="map-container">
        <MapContainer
          center={mapCenter}
          zoom={mapZoom}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapUpdater center={mapCenter} zoom={mapZoom} />
          {photos.map((photo) => (
            photo.lat && photo.lng && (
              <Marker
                key={photo.id}
                position={[photo.lat, photo.lng]}
                icon={selectedPhoto?.id === photo.id ? selectedIcon : defaultIcon}
                eventHandlers={{
                  click: () => handlePhotoClick(photo)
                }}
              >
                <Popup>
                  <div>
                    <strong>{formatDate(photo.captureTime || photo.timestamp)}</strong>
                    <br />
                    <small>
                      Lat: {photo.lat.toFixed(6)}, Lng: {photo.lng.toFixed(6)}
                      <br />
                      Alt: {photo.altMsl?.toFixed(1)}m MSL / {photo.altRel?.toFixed(1)}m AGL
                      <br />
                      Gimbal: P:{photo.pitch?.toFixed(1)}° R:{photo.roll?.toFixed(1)}° Y:{photo.yaw?.toFixed(1)}°
                      {photo.hostname && <><br />Host: {photo.hostname}</>}
                    </small>
                  </div>
                </Popup>
              </Marker>
            )
          ))}
        </MapContainer>
      </div>

      <div className="sidebar">
        <div className="header">
          <h1>📷 Photo Captures</h1>
          <div className="stats">
            {photos.length} photos · {syncedCount} synced · {photos.length - syncedCount} pending
          </div>
          <div className="auto-pan-control">
            <label>
              <input
                type="checkbox"
                checked={autoPan}
                onChange={(e) => setAutoPan(e.target.checked)}
              />
              <span>Auto-Pan to New Photos</span>
            </label>
          </div>
        </div>

        <div className="photo-list">
          {loading && <div className="loading">Loading photos...</div>}
          {error && <div className="error">Error: {error}</div>}
          
          {!loading && !error && photos.length === 0 && (
            <div className="loading">No photos captured yet</div>
          )}

          {!loading && !error && photos.map((photo) => (
            <div
              key={photo.id}
              className={`photo-item ${selectedPhoto?.id === photo.id ? 'selected' : ''}`}
              onClick={() => handlePhotoClick(photo)}
            >
              <div className="timestamp">
                {formatDate(photo.captureTime || photo.timestamp)}
              </div>
              <div className="location">
                📍 {photo.lat?.toFixed(6)}, {photo.lng?.toFixed(6)}
              </div>
              <div className="details">
                <span>🏔️ {photo.altMsl?.toFixed(0)}m</span>
                <span>📐 {photo.altRel?.toFixed(0)}m</span>
                <span>🎯 {photo.yaw?.toFixed(0)}°</span>
              </div>
              {photo.hostname && (
                <div className="details">
                  <span>💻 {photo.hostname}</span>
                </div>
              )}
              <div>
                <span className={`badge ${photo.synced ? 'synced' : 'unsynced'}`}>
                  {photo.synced ? '✓ Synced' : '⏳ Pending'}
                  {photo.syncAttempts > 0 && ` (${photo.syncAttempts} attempts)`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
