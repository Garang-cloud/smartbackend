// Simulate sensor data publishing to MQTT for testing the dashboard
const mqtt = require('mqtt');

const MQTT_BROKER_URL = 'mqtt://broker.hivemq.com:1883';
const SENSOR_DATA_TOPIC = 'farm/plot1/sensor_data';

const client = mqtt.connect(MQTT_BROKER_URL);

client.on('connect', () => {
    console.log('Simulator connected to MQTT broker');
    setInterval(() => {
        const soilMoisture = Math.floor(Math.random() * 100); // 0-99
        const pumpStatus = Math.random() > 0.5 ? 'ON' : 'OFF';
        const payload = JSON.stringify({ soilMoisture, pumpStatus });
        client.publish(SENSOR_DATA_TOPIC, payload, {}, (err) => {
            if (err) {
                console.error('Failed to publish simulated data:', err);
            } else {
                console.log('Published:', payload);
            }
        });
    }, 5000); // every 5 seconds
});

client.on('error', (err) => {
    console.error('Simulator MQTT error:', err);
});
