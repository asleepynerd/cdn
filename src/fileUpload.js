const fetch = require('node-fetch');
const crypto = require('crypto');
const logger = require('./config/logger');
const storage = require('./storage');
const {generateFileUrl} = require('./utils');

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;  // 2GB in bytes
const CONCURRENT_UPLOADS = 3;                    // Max concurrent uploads (messages)

const processedMessages = new Map();
let uploadLimit;

async function initialize() {
    const pLimit = (await import('p-limit')).default;
    uploadLimit = pLimit(CONCURRENT_UPLOADS);
}

// Basic stuff
function isMessageTooOld(eventTs) {
    const eventTime = parseFloat(eventTs) * 1000;
    return (Date.now() - eventTime) > 24 * 60 * 60 * 1000;
}

function isMessageProcessed(messageTs) {
    return processedMessages.has(messageTs);
}

function markMessageAsProcessing(messageTs) {
    processedMessages.set(messageTs, true);
}

// File processing
function sanitizeFileName(fileName) {
    let sanitized = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    return sanitized || `upload_${Date.now()}`;
}

function generateUniqueFileName(fileName) {
    return `${Date.now()}-${crypto.randomBytes(16).toString('hex')}-${sanitizeFileName(fileName)}`;
}

// upload functionality
async function processFiles(fileMessage, client) {
    const uploadedFiles = [];
    const failedFiles = [];

    logger.info(`Processing ${fileMessage.files?.length || 0} files`);

    for (const file of fileMessage.files || []) {
        try {
            if (file.size > MAX_FILE_SIZE) {
                failedFiles.push(file.name);
                continue;
            }

            const response = await fetch(file.url_private, {
                headers: {Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`}
            });

            if (!response.ok) throw new Error('Download failed');

            const buffer = await response.buffer();
            const uniqueFileName = generateUniqueFileName(file.name);
            const userDir = `s/${fileMessage.user}`;

            const success = await uploadLimit(() => 
                storage.uploadToStorage(userDir, uniqueFileName, buffer, file.mimetype)
            );

            if (!success) throw new Error('Upload failed');

            uploadedFiles.push({
                name: uniqueFileName,
                url: generateFileUrl(userDir, uniqueFileName),
                contentType: file.mimetype
            });

        } catch (error) {
            logger.error(`Failed: ${file.name} - ${error.message}`);
            failedFiles.push(file.name);
        }
    }

    logger.info(`Completed: ${uploadedFiles.length} ok, ${failedFiles.length} failed`);
    return {uploadedFiles, failedFiles};
}

// Slack interaction
async function addProcessingReaction(client, event, fileMessage) {
    try {
        await client.reactions.add({
            name: 'beachball',
            timestamp: fileMessage.ts,
            channel: event.channel_id
        });
    } catch (error) {
        logger.error('Failed to add reaction:', error.message);
    }
}

async function updateReactions(client, event, fileMessage, success) {
    try {
        await client.reactions.remove({
            name: 'beachball',
            timestamp: fileMessage.ts,
            channel: event.channel_id
        });
        await client.reactions.add({
            name: success ? 'white_check_mark' : 'x',
            timestamp: fileMessage.ts,
            channel: event.channel_id
        });
    } catch (error) {
        logger.error('Failed to update reactions:', error.message);
    }
}

async function findFileMessage(event, client) {
    try {
        const fileInfo = await client.files.info({
            file: event.file_id,
            include_shares: true
        });

        if (!fileInfo.ok || !fileInfo.file) {
            throw new Error('Could not get file info');
        }

        const channelShare = fileInfo.file.shares?.public?.[event.channel_id] ||
            fileInfo.file.shares?.private?.[event.channel_id];

        if (!channelShare || !channelShare.length) {
            throw new Error('No share info found for this channel');
        }

        // Get the exact message using the ts from share info
        const messageTs = channelShare[0].ts;

        const messageInfo = await client.conversations.history({
            channel: event.channel_id,
            latest: messageTs,
            limit: 1,
            inclusive: true
        });

        if (!messageInfo.ok || !messageInfo.messages.length) {
            throw new Error('Could not find original message');
        }

        return messageInfo.messages[0];
    } catch (error) {
        logger.error('Error finding file message:', error);
        return null;
    }
}

async function sendResultsMessage(client, channelId, fileMessage, uploadedFiles, failedFiles) {
    let message = `Hey <@${fileMessage.user}>, `;
    if (uploadedFiles.length > 0) {
        message += `here ${uploadedFiles.length === 1 ? 'is your link' : 'are your links'}:\n`;
        message += uploadedFiles.map(f => `• ${f.name}: ${f.url}`).join('\n');
    }
    if (failedFiles.length > 0) {
        message += `\n\nFailed to process: ${failedFiles.join(', ')}`;
    }

    await client.chat.postMessage({
        channel: channelId,
        thread_ts: fileMessage.ts,
        text: message
    });
}

async function handleError(client, channelId, fileMessage, reactionAdded) {
    if (fileMessage && reactionAdded) {
        try {
            await client.reactions.remove({
                name: 'beachball',
                timestamp: fileMessage.ts,
                channel: channelId
            });
        } catch (cleanupError) {
            if (cleanupError.data.error !== 'no_reaction') {
                logger.error('Cleanup error:', cleanupError);
            }
        }
        try {
            await client.reactions.add({
                name: 'x',
                timestamp: fileMessage.ts,
                channel: channelId
            });
        } catch (cleanupError) {
            logger.error('Cleanup error:', cleanupError);
        }
    }
}

async function handleFileUpload(event, client) {
    let fileMessage = null;
    let reactionAdded = false;

    try {
        if (isMessageTooOld(event.event_ts)) return;

        fileMessage = await findFileMessage(event, client);
        if (!fileMessage || isMessageProcessed(fileMessage.ts)) return;

        markMessageAsProcessing(fileMessage.ts);
        await addProcessingReaction(client, event, fileMessage);
        reactionAdded = true;

        const {uploadedFiles, failedFiles} = await processFiles(fileMessage, client);
        await sendResultsMessage(client, event.channel_id, fileMessage, uploadedFiles, failedFiles);
        await updateReactions(client, event, fileMessage, failedFiles.length === 0);

    } catch (error) {
        logger.error(`Upload failed: ${error.message}`);
        await handleError(client, event.channel_id, fileMessage, reactionAdded);
        throw error;
    }
}

module.exports = { handleFileUpload, initialize };
