// Simulate sensor data publishing to MQTT for testing the dashboard
const mqtt = require('mqtt');

const MQTT_BROKER_URL = 'mqtt://broker.hivemq.com:1883'; // Ensure this matches your server.js
const SENSOR_DATA_TOPIC = 'farm/plot1/sensor_data';

const client = mqtt.connect(MQTT_BROKER_URL);

client.on('connect', () => {
    console.log('Simulator connected to MQTT broker');
    setInterval(() => {
        const soilMoisture = Math.floor(Math.random() * (900 - 300 + 1)) + 300; // Simulate 300-900 range
        const pumpStatus = soilMoisture > 700 ? 'ON' : 'OFF'; // Simple logic for pump status

        // --- NEW: Simulate Temperature and Humidity ---
        const temperature = (Math.random() * (35 - 15) + 15).toFixed(1); // e.g., 15.0 to 35.0 °C
        const humidity = Math.floor(Math.random() * (95 - 40 + 1)) + 40; // e.g., 40% to 95%

        const payload = JSON.stringify({ soilMoisture, pumpStatus, temperature, humidity }); // Include new data
        client.publish(SENSOR_DATA_TOPIC, payload, {}, (err) => {
            if (err) {
                console.error('Failed to publish simulated data:', err);
            } else {
                console.log('Published:', payload);
            }
        });
    }, 5000); // Publish every 5 seconds
});

client.on('error', (err) => {
    console.error('Simulator MQTT error:', err);
});
