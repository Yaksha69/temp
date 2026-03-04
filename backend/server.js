require('dotenv').config();

console.log('Starting server...');
console.log('PORT:', process.env.PORT);
console.log('DB_URI:', process.env.DB_URI ? 'SET' : 'NOT SET');

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { WebSocketServer } = require('ws');

// Import your data routes
const dataRoutes = require('./routes/dataRoutes');
const smsRoutes = require('./routes/smsRoutes');
const customAlertRoutes = require('./routes/customAlertRoutes');
const smsSettingsRoutes = require('./routes/smsSettingsRoutes');
const Data = require('./models/Data');
const SmsSettings = require('./models/SmsSettings');

const app = express();

app.use(cors({
    origin: '*', // Allow all origins (e.g. 127.0.0.1:5500, localhost)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

// Ensure preflight requests are handled
app.options('*', cors());

app.use(express.json());

// Define routes before database connection
const requestMapper = '/api/v1';
app.use(requestMapper + '/data', dataRoutes);
app.use(requestMapper + '/sms', smsRoutes);
app.use(requestMapper + '/custom-alerts', customAlertRoutes);
app.use(requestMapper + '/sms-settings', smsSettingsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    console.log('📍 Health route accessed');
    
    // Check database connection status
    const dbState = mongoose.connection.readyState;
    const dbStatus = dbState === 1 ? 'connected' : 'disconnected';
    
    res.json({ 
        status: 'OK', 
        message: 'Server is running',
        database: dbStatus,
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Readiness probe for Kubernetes/Render
app.get('/ready', (req, res) => {
    const dbState = mongoose.connection.readyState;
    const isReady = dbState === 1;
    
    if (isReady) {
        res.status(200).json({ status: 'ready' });
    } else {
        res.status(503).json({ status: 'not ready', database: dbState });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: "No such method exists" });
});

// Connect to MongoDB
mongoose.connect(process.env.DB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    bufferCommands: false
})
    .then(() => {
        const server = app.listen(process.env.PORT, () => {
            console.log('✅ Connected to the database...');
            console.log('✅ Server listening on port:', process.env.PORT);
            console.log('✅ Health check available at: /health');
            console.log('✅ API available at: /api/v1/data');
        });

        // WebSocket server initialization
        const wss = new WebSocketServer({ server });
        console.log('✅ WebSocket server initialized');

        let lastSentData = null;

        // Send data to all connected WebSocket clients
        const sendDataToClients = async () => {
            try {
                // Fetch last 10 data points from the database, sorted by creation time
                const allData = await Data.find()
                    .sort({ createdAt: -1 })
                    .limit(10);  // Limit to 10 most recent entries
                
                // Reverse the array so it's in chronological order
                const orderedData = allData.reverse();
                
                if (orderedData.length > 0) {
                    wss.clients.forEach(client => {
                        if (client.readyState === client.OPEN) {
                            client.send(JSON.stringify({ type: 'initial', data: orderedData }));
                        }
                    });
                }
            } catch (error) {
                console.error('Error fetching data from database:', error);
            }
        };

        // Send updates for new data
        const sendNewDataToClients = async () => {
            try {
                const latestData = await Data.findOne().sort({ createdAt: -1 });
                
                // Only send if we have new data (comparing timestamps)
                if (latestData && (!lastSentData || latestData.createdAt > lastSentData.createdAt)) {
                    lastSentData = latestData;
                    wss.clients.forEach(client => {
                        if (client.readyState === client.OPEN) {
                            client.send(JSON.stringify({ type: 'update', data: latestData }));
                        }
                    });
                }
            } catch (error) {
                console.error('Error fetching latest data:', error);
            }
        };

        // When a client connects, send initial data and store the last sent data
        wss.on('connection', async (ws) => {
            console.log('Client connected');
            await sendDataToClients();
            // Store the most recent data point
            lastSentData = await Data.findOne().sort({ createdAt: -1 });
        });

        // Update with new data every 500ms
        setInterval(sendNewDataToClients, 500);

        // Helper: send SMS via iProg API (shared for scheduled alerts)
        const sendBulkSms = async (phoneNumbers, message) => {
            const apiToken = process.env.SMS_API_TOKEN;
            if (!apiToken) {
                console.error('❌ SMS_API_TOKEN not configured in backend');
                return;
            }
            if (!phoneNumbers || phoneNumbers.length === 0) {
                console.warn('⚠️ No phone numbers configured, skipping SMS send');
                return;
            }

            try {
                const encodedPhoneNumbers = phoneNumbers.join('%2C');
                const smsUrl = `https://www.iprogsms.com/api/v1/sms_messages/send_bulk?api_token=${apiToken}&message=${encodeURIComponent(message)}&phone_number=${encodedPhoneNumbers}`;

                console.log('⏰📱 Sending scheduled SMS to:', phoneNumbers);
                console.log('⏰📱 Message:', message);

                const response = await fetch(smsUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_token: apiToken,
                        phone_number: phoneNumbers.join(','),
                        message
                    })
                });

                console.log('⏰📱 SMS API Response status:', response.status);

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('❌ Scheduled SMS sending failed:', response.status, response.statusText, errorText);
                    return;
                }

                const result = await response.json();
                console.log('✅ Scheduled SMS sent successfully:', result);
            } catch (error) {
                console.error('❌ Error sending scheduled SMS:', error);
            }
        };

        // Periodically check scheduled alerts (every 60 seconds)
        const checkScheduledAlerts = async () => {
            try {
                const settings = await SmsSettings.findOne();

                if (
                    !settings ||
                    !settings.enableAlerts ||
                    !Array.isArray(settings.phoneNumbers) ||
                    settings.phoneNumbers.length === 0 ||
                    !Array.isArray(settings.scheduledAlerts) ||
                    settings.scheduledAlerts.length === 0
                ) {
                    return;
                }

                const now = new Date();
                const cooldownMinutes =
                    typeof settings.cooldownMinutes === 'number'
                        ? settings.cooldownMinutes
                        : 30;
                const lastAlertTimes = settings.lastAlertTimes || new Map();

                const shouldSendForKey = (key) => {
                    const last = lastAlertTimes.get(key);
                    if (!last) return true;
                    const diffMs = now - new Date(last);
                    const diffMinutes = diffMs / (1000 * 60);
                    return diffMinutes >= cooldownMinutes;
                };

                const markSentForKey = (key) => {
                    lastAlertTimes.set(key, now.toISOString());
                };

                // Respect global cooldown as well
                if (!shouldSendForKey('global')) {
                    return;
                }

                const messagesToSend = [];

                settings.scheduledAlerts.forEach((alert) => {
                    if (!alert.time || !alert.message) return;

                    const [hh, mm] = String(alert.time).split(':');
                    if (hh == null || mm == null) return;

                    const scheduled = new Date(now);
                    scheduled.setHours(parseInt(hh, 10), parseInt(mm, 10), 0, 0);

                    const diffMinutes = (now - scheduled) / (1000 * 60);

                    // Fire if now is within 0–5 minutes after scheduled time
                    if (diffMinutes >= 0 && diffMinutes <= 5) {
                        const key = `scheduled_${alert.id}`;
                        if (!shouldSendForKey(key)) return;

                        messagesToSend.push({
                            key,
                            message: alert.message
                        });
                    }
                });

                if (messagesToSend.length === 0) return;

                const combinedMessage = messagesToSend
                    .map((m) => m.message)
                    .join(' ');

                await sendBulkSms(settings.phoneNumbers, combinedMessage);

                messagesToSend.forEach((m) => markSentForKey(m.key));
                markSentForKey('global');

                settings.lastAlertTimes = lastAlertTimes;
                settings.updatedAt = now;
                await settings.save();
            } catch (error) {
                console.error('❌ Error checking scheduled SMS alerts:', error);
            }
        };

        setInterval(checkScheduledAlerts, 60_000);

    })
    .catch(err => {
        console.error('❌ Database connection error:', err);
        console.log('⚠️ Server will continue running without database...');
        
        // Start server even if database fails
        const server = app.listen(process.env.PORT, () => {
            console.log('⚠️ Server running on port', process.env.PORT, '(without database)');
            console.log('📍 Available endpoints:');
            console.log('   GET  /health');
            console.log('   GET  /ready');
            console.log('   GET  /api/v1/data/all');
            console.log('   POST /api/v1/data/new');
        });
        
        // Retry database connection periodically
        const retryDbConnection = async () => {
            try {
                if (mongoose.connection.readyState !== 1) {
                    console.log('🔄 Attempting to reconnect to database...');
                    await mongoose.connect(process.env.DB_URI, {
                        serverSelectionTimeoutMS: 5000,
                        socketTimeoutMS: 45000,
                        bufferCommands: false
                    });
                    console.log('✅ Database reconnected');
                }
            } catch (error) {
                console.error('❌ Database reconnection failed:', error);
            }
        };
        
        // Try to reconnect every 30 seconds
        setInterval(retryDbConnection, 30000);
    });

// Handle process events to prevent early exit
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGTERM', () => {
    console.log('📡 SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📡 SIGINT received, shutting down gracefully');
    process.exit(0);
});

// Handle any unhandled promise rejections
process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Promise Rejection:', err);
});
