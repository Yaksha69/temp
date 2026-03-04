const { response } = require('express')
const Data = require('../models/Data')
const mongoose = require('mongoose')
const SmsSettings = require('../models/SmsSettings')

// Helper: send SMS via iProg API
const sendBulkSms = async (phoneNumbers, message) => {
    const apiToken = process.env.SMS_API_TOKEN
    
    if (!apiToken) {
        console.error('❌ SMS_API_TOKEN not configured in backend')
        return
    }

    if (!phoneNumbers || phoneNumbers.length === 0) {
        console.warn('⚠️ No phone numbers configured, skipping SMS send')
        return
    }

    try {
        const encodedPhoneNumbers = phoneNumbers.join('%2C')
        const smsUrl = `https://www.iprogsms.com/api/v1/sms_messages/send_bulk?api_token=${apiToken}&message=${encodeURIComponent(message)}&phone_number=${encodedPhoneNumbers}`

        console.log('📱 Sending SMS to:', phoneNumbers)
        console.log('📱 Message:', message)

        const response = await fetch(smsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                api_token: apiToken,
                phone_number: phoneNumbers.join(','),
                message,
            }),
        })

        console.log('📱 SMS API Response status:', response.status)

        if (!response.ok) {
            const errorText = await response.text()
            console.error(
                '❌ SMS sending failed:',
                response.status,
                response.statusText,
                errorText
            )
            return
        }

        const result = await response.json()
        console.log('✅ SMS sent successfully:', result)
    } catch (error) {
        console.error('❌ Error sending SMS:', error)
    }
}

// Helper: evaluate thresholds and custom alerts for a new data point
const checkAndSendAlerts = async (dataDoc) => {
    try {
        const settings = await SmsSettings.findOne()

        if (
            !settings ||
            !settings.enableAlerts ||
            !Array.isArray(settings.phoneNumbers) ||
            settings.phoneNumbers.length === 0
        ) {
            console.log('ℹ️ SMS alerts disabled or no phone numbers configured')
            return
        }

        const now = new Date()
        const cooldownMinutes =
            typeof settings.cooldownMinutes === 'number'
                ? settings.cooldownMinutes
                : 30
        const lastAlertTimes = settings.lastAlertTimes || new Map()

        const phoneNumbers = settings.phoneNumbers
        const hi = Number(dataDoc.heatIndex)
        const temp = Number(dataDoc.temperature)

        const shouldSendForKey = (key) => {
            const last = lastAlertTimes.get(key)
            if (!last) return true
            const diffMs = now - new Date(last)
            const diffMinutes = diffMs / (1000 * 60)
            return diffMinutes >= cooldownMinutes
        }

        const markSentForKey = (key) => {
            lastAlertTimes.set(key, now.toISOString())
        }

        const messagesToSend = []

        // Global cooldown across all alerts
        if (!shouldSendForKey('global')) {
            console.log(
                'ℹ️ Global SMS cooldown active, skipping alerts for this data point'
            )
            return
        }

        // 1) Built-in Heat Index levels
        if (!isNaN(hi)) {
            const t = settings.thresholds || {}
            let levelKey = null
            let levelLabel = null

            if (hi >= 27 && hi < 32 && t.caution !== false) {
                levelKey = 'heatIndex_caution'
                levelLabel = 'Caution'
            } else if (hi >= 32 && hi < 41 && t.extremeCaution !== false) {
                levelKey = 'heatIndex_extremeCaution'
                levelLabel = 'Extreme Caution'
            } else if (hi >= 41 && hi < 54 && t.danger !== false) {
                levelKey = 'heatIndex_danger'
                levelLabel = 'Danger'
            } else if (hi >= 54 && t.extremeDanger !== false) {
                levelKey = 'heatIndex_extremeDanger'
                levelLabel = 'Extreme Danger'
            }

            if (levelKey && levelLabel && shouldSendForKey(levelKey)) {
                const msg = `Heat alert (${levelLabel}): Heat index is ${hi.toFixed(
                    1
                )}°C (Temp: ${temp.toFixed(1)}°C).`
                messagesToSend.push({ key: levelKey, message: msg })
            }
        }

        // 2) Custom alerts (temperature / heatIndex with conditions)
        if (Array.isArray(settings.customAlerts)) {
            for (const alert of settings.customAlerts) {
                const metricValue =
                    alert.metric === 'temperature' ? temp : hi

                if (isNaN(metricValue)) continue

                let conditionMet = false
                if (alert.condition === 'greater') {
                    conditionMet = metricValue > alert.value
                } else if (alert.condition === 'less') {
                    conditionMet = metricValue < alert.value
                } else if (alert.condition === 'equal') {
                    conditionMet = metricValue === alert.value
                }

                if (!conditionMet) continue

                const key = `custom_${alert.id}`
                if (!shouldSendForKey(key)) continue

                messagesToSend.push({
                    key,
                    message: alert.message,
                })
            }
        }

        if (messagesToSend.length === 0) {
            console.log('ℹ️ No SMS alerts triggered for this data point')
            return
        }

        // Actually send all messages (one combined SMS to avoid spamming)
        const combinedMessage = messagesToSend
            .map((m) => m.message)
            .join(' ')
        await sendBulkSms(phoneNumbers, combinedMessage)

        // Update cooldown timestamps (per-alert + global)
        messagesToSend.forEach((m) => markSentForKey(m.key))
        markSentForKey('global')
        settings.lastAlertTimes = lastAlertTimes
        settings.updatedAt = now
        await settings.save()
    } catch (err) {
        console.error('❌ Error checking/sending SMS alerts:', err)
    }
}

const addData = async(req, res) =>{
    console.log('📝 POST /api/v1/data/new - Request received');
    console.log('📝 Body:', req.body);
    
    const {temperature, humidity, heatIndex, light} = req.body

    try{
        const new_data = await Data.create({temperature, humidity, heatIndex, light})
        console.log('✅ Data saved successfully:', new_data);

        // After saving data, check SMS alert rules
        await checkAndSendAlerts(new_data)

        res.status(200).json(new_data)
    }catch(err){
        console.error('❌ Error saving data:', err);
        res.status(500).json({error: err.message})
    }
}

const  getAllData = async(req, res) =>{
    console.log('📋 GET /api/v1/data/all - Request received');
    
    try{
        const data = await Data.find({})
        console.log('✅ Found', data.length, 'data records');
        res.status(200).json(data)
    }catch(err){
        console.error('❌ Error fetching data:', err);
        res.status(500).json({error: err.message})
    }
}

/*const  getData = async(req, res) =>{ 
    const data =   await Data.find({createdAt: })
    res.status(200).json(data)
}*/


module.exports = {
    addData,
    getAllData,
}
