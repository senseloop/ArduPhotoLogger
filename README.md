Node JS Server app for Mavlink companion computer
Logs stores relevant data in memory and dumps photo events with relevant data to database when a photo is taken. 

API endpoinst:
/api/cleardatabase              Reset database
/api/photocapturelis            List of events. With "dl=true" the dataset is downloaded as csv file.
/api/photocapturelistgeojson    List of events as geosjon. WIth "dl=true" the dataset is downloaded as geojson file. 

