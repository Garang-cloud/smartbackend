const express = require('express');
const mqtt = require('mqtt');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose'); // NEW: Import Mongoose
const bcrypt = require('bcryptjs'); // NEW: Import bcryptjs
require('dotenv').config(); // NEW: Load environment variables from .env file

const app = express();
const port = process.env.PORT || 5000;

// NEW: MongoDB Connection URI (Get this from local MongoDB or MongoDB Atlas)
// It tries to read from MONGO_URI environment variable, falls back to local if not set.
const DB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/smartirrigation';

// --- MongoDB Connection ---
mongoose.connect(DB_URI)
    .then(() => console.log('MongoDB Connected...')) // Success message
    .catch(err => console.error('MongoDB connection error:', err)); // Error message

// NEW: User Schema and Model Definition (for authentication)
const UserSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true // Ensures each user has a unique email
    },
    password: {
        type: String,
        required: true
    },
    role: { // Added for future extension (e.g., 'user', 'farmer', 'admin')
        type: String,
        enum: ['user', 'farmer', 'admin'], // Only these values are allowed
        default: 'user' // Default role for new users
    },
    date: {
        type: Date,
        default: Date.now // Automatically sets the creation date
    }
});

// NEW: Pre-save hook to hash password before saving a user
// This ensures passwords are never stored in plain text in the database.
UserSchema.pre('save', async function(next) {
    // Only hash the password if it has been modified (or is new)
    if (!this.isModified('password')) {
        return next();
    }
    const salt = await bcrypt.genSalt(10); // Generate a salt (random string) for hashing
    this.password = await bcrypt.hash(this.password, salt); // Hash the password using the salt
    next(); // Proceed with saving the user
});

const User = mongoose.model('User', UserSchema); // Define the 'User' model based on the schema

// --- TEMPORARY TEST CODE: Create a test user to verify DB and hashing ---
// UNCOMMENT THIS BLOCK, RUN SERVER ONCE, THEN COMMENT IT OUT AGAIN OR REMOVE!
/*
async function createTestUser() {
    try {
        const testUser = new User({
            name: 'Test User',
            email: 'test@example.com',
            password: 'password123', // This password will be hashed
            role: 'user'
        });

        // Check if a user with this email already exists to prevent duplicates
        const existingUser = await User.findOne({ email: 'test@example.com' });
        if (existingUser) {
            console.log('Test user (test@example.com) already exists. Skipping creation.');
            return;
        }

        await testUser.save();
        console.log('Test User Created Successfully:');
        console.log('Name:', testUser.name);
        console.log('Email:', testUser.email);
        console.log('Hashed Password (should not be readable):', testUser.password);
        console.log('Role:', testUser.role);
    } catch (error) {
        console.error('Error creating test user:', error.message);
    }
}

// Call the function when the server starts, after MongoDB connects
mongoose.connection.once('open', () => {
    createTestUser();
});
*/
// --- END TEMPORARY TEST CODE ---


// MQTT Broker connection details
const MQTT_BROKER_URL = 'mqtt://broker.hivemq.com:1883';
const MQTT_USERNAME = ''; // Keep these empty if not used by HiveMQ public broker
const MQTT_PASSWORD = ''; // Keep these empty if not used by HiveMQ public broker

// MQTT Topics for sensor data and commands
const SENSOR_DATA_TOPIC = 'farm/plot1/sensor_data';
const COMMAND_TOPIC = 'farm/plot1/commands';

// Store latest sensor data and history in memory (for now)
let latestSensorData = { soilMoisture: null, pumpStatus: 'OFF', temperature: null, humidity: null, timestamp: null };
let historicalData = []; // Stores a limited history of sensor readings

// --- Automation Specific Variables ---
// Soil moisture thresholds for automation (adjust these values based on your sensor calibration)
const MOISTURE_DRY_THRESHOLD = 700; // If soilMoisture is GREATER than this, it's considered dry, turn pump ON
const MOISTURE_WET_THRESHOLD = 400; // If soilMoisture is LESS than this, it's considered wet, turn pump OFF
const PUMP_COOLDOWN_SECONDS = 30; // Time in seconds before the pump can change state again after a command
let lastPumpCommandTime = 0; // Timestamp (milliseconds) of the last pump command sent (manual or automated)

// Weather data variables (for future OpenWeatherMap integration)
// NEW: Use process.env for the API key for better security
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '78200193b0032a74abeb85e020eafcac'; // Your hardcoded key if .env not used
const WEATHER_CITY = 'Nairobi';
const WEATHER_COUNTRY_CODE = 'KE';
const WEATHER_UNITS = 'metric';
let latestWeatherData = {
    temperature: null,
    feels_like: null,
    description: null,
    icon: null,
    city: null,
    humidity: null,
    wind_speed: null,
    timestamp: null
};

// Middleware setup
app.use(bodyParser.json()); // Parses JSON bodies of incoming requests
app.use(cors()); // Enables Cross-Origin Resource Sharing for frontend communication

// MQTT Client connection
const client = mqtt.connect(MQTT_BROKER_URL, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD
});

// MQTT 'connect' event handler
client.on('connect', () => {
    console.log('Connected to MQTT Broker');
    // Subscribe to the sensor data topic
    client.subscribe(SENSOR_DATA_TOPIC, (err) => {
        if (!err) {
            console.log(`Subscribed to ${SENSOR_DATA_TOPIC}`);
        } else {
            console.error('MQTT Subscription error:', err);
        }
    });
});

// MQTT 'message' event handler: Processes incoming sensor data
client.on('message', (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        console.log(`Received message from ${topic}:`, data);

        if (topic === SENSOR_DATA_TOPIC) {
            // Update latest sensor data
            latestSensorData = {
                soilMoisture: data.soilMoisture,
                pumpStatus: data.pumpStatus || 'UNKNOWN', // Use data.pumpStatus if provided by sensor, else 'UNKNOWN'
                temperature: data.temperature !== undefined ? parseFloat(data.temperature) : null,
                humidity: data.humidity !== undefined ? parseInt(data.humidity) : null,
                timestamp: new Date()
            };
            // Add to historical data, keeping the array size limited
            historicalData.push(latestSensorData);
            if (historicalData.length > 200) { // Keep only the last 200 readings
                historicalData.shift();
            }

            // --- AUTOMATION LOGIC FOR PUMP CONTROL ---
            const currentSoilMoisture = latestSensorData.soilMoisture;
            const currentPumpStatus = latestSensorData.pumpStatus;
            const currentTime = Date.now(); // Get current timestamp in milliseconds

            // Determine if a new pump command can be sent based on cooldown
            const canSendPumpCommand = (currentTime - lastPumpCommandTime) / 1000 >= PUMP_COOLDOWN_SECONDS;

            if (canSendPumpCommand) {
                // Check if soil is dry and pump is off -> turn pump ON
                if (currentSoilMoisture > MOISTURE_DRY_THRESHOLD && currentPumpStatus === 'OFF') {
                    console.log(`Automation: Soil moisture (${currentSoilMoisture}) is dry. Turning pump ON.`);
                    client.publish(COMMAND_TOPIC, JSON.stringify({ command: 'TURN_PUMP_ON' }), (err) => {
                        if (!err) lastPumpCommandTime = currentTime; // Update cooldown time only on successful publish
                        else console.error('Error publishing ON command:', err);
                    });
                }
                // Check if soil is wet enough and pump is on -> turn pump OFF
                else if (currentSoilMoisture < MOISTURE_WET_THRESHOLD && currentPumpStatus === 'ON') {
                    console.log(`Automation: Soil moisture (${currentSoilMoisture}) is wet. Turning pump OFF.`);
                    client.publish(COMMAND_TOPIC, JSON.stringify({ command: 'TURN_PUMP_OFF' }), (err) => {
                        if (!err) lastPumpCommandTime = currentTime; // Update cooldown time only on successful publish
                        else console.error('Error publishing OFF command:', err);
                    });
                } else {
                    // Pump is already in the desired state or moisture is within acceptable range
                    console.log(`Automation: Soil moisture (${currentSoilMoisture}) is within range or pump is already in desired state (${currentPumpStatus}).`);
                }
            } else {
                // Pump command is in cooldown, log remaining time
                const remainingTime = PUMP_COOLDOWN_SECONDS - Math.floor((currentTime - lastPumpCommandTime) / 1000);
                console.log(`Automation: Pump command cooldown active. Cannot send command for another ${remainingTime} seconds.`);
            }
            // --- END AUTOMATION LOGIC ---
        }
    } catch (e) {
        console.error('Failed to parse MQTT message:', message.toString(), e);
    }
});

// MQTT 'error' event handler
client.on('error', (err) => {
    console.error('MQTT Connection Error:', err);
});

// MQTT 'reconnect' event handler
client.on('reconnect', () => {
    console.log('Attempting to reconnect to MQTT Broker...');
});

// --- API Endpoints for Frontend ---

// GET /api/data/latest: Returns the most recent sensor data and automation details
app.get('/api/data/latest', (req, res) => {
    res.json({
        ...latestSensorData, // Spread existing latest sensor data
        lastPumpCommandTime: lastPumpCommandTime, // Add timestamp of last pump command
        pumpCooldownSeconds: PUMP_COOLDOWN_SECONDS, // Add total cooldown duration
        automationEnabled: true // Indicate that automation is enabled (can be made dynamic later)
    });
});

// GET /api/data/history: Returns a history of sensor data
app.get('/api/data/history', (req, res) => {
    res.json([...historicalData]); // Send a copy to prevent external modification
});

// POST /api/command: Receives manual pump commands from the frontend
app.post('/api/command', (req, res) => {
    const { action } = req.body;
    if (action) {
        // When a manual command is sent, reset the cooldown timer immediately
        lastPumpCommandTime = Date.now();
        // Publish the command to the MQTT topic
        client.publish(COMMAND_TOPIC, JSON.stringify({ command: action }), (err) => {
            if (err) {
                console.error('Failed to publish command:', err);
                return res.status(500).json({ success: false, message: 'Failed to send command via MQTT' });
            }
            console.log(`Manual command '${action}' sent to ${COMMAND_TOPIC}`);
            res.json({ success: true, message: `Command '${action}' sent.` });
        });
    } else {
        res.status(400).json({ success: false, message: 'Action is required in request body.' });
    }
});

// --- Weather Data Endpoints ---

// Function to fetch weather data from OpenWeatherMap
const fetchWeatherData = async () => {
    // Check if API key is set before attempting to fetch
    if (!OPENWEATHER_API_KEY || OPENWEATHER_API_KEY === 'YOUR_OPENWEATHER_API_KEY') {
        console.warn('OpenWeatherMap API key not set in .env. Skipping weather fetch.');
        return;
    }
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${WEATHER_CITY},${WEATHER_COUNTRY_CODE}&units=${WEATHER_UNITS}&appid=${OPENWEATHER_API_KEY}`;
    try {
        const response = await axios.get(url);
        const data = response.data;
        // Update latest weather data
        latestWeatherData = {
            temperature: data.main.temp,
            feels_like: data.main.feels_like,
            description: data.weather[0].description,
            icon: data.weather[0].icon,
            city: data.name,
            humidity: data.main.humidity,
            wind_speed: data.wind.speed,
            timestamp: new Date()
        };
        console.log('Fetched weather data:', latestWeatherData);
    } catch (error) {
        console.error('Error fetching weather data:', error.message);
        if (error.response) {
            console.error('Weather API response error:', error.response.status, error.response.data);
        }
    }
};

// Fetch weather data initially when the server starts
fetchWeatherData();
// Set up interval to fetch weather data periodically (e.g., every 10 minutes)
setInterval(fetchWeatherData, 10 * 60 * 1000);

// API endpoint to serve the latest weather data to the frontend
app.get('/api/weather/latest', (req, res) => {
    res.json(latestWeatherData);
});


// Start the Express server
app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
    console.log(`MQTT Broker URL: ${MQTT_BROKER_URL}`);
});
