const fetch = require('node-fetch');
const crypto = require('crypto');
const {uploadToStorage} = require('../storage');
const {generateUrl, getCdnUrl} = require('./utils');
const logger = require('../config/logger');

// Sanitize file name for storage
function sanitizeFileName(fileName) {
    let sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    if (!sanitizedFileName) {
        sanitizedFileName = 'upload_' + Date.now();
    }
    return sanitizedFileName;
}

// Handle remote file upload to S3 storage
const uploadEndpoint = async (url, authorization = null) => {
    try {
        logger.debug('Starting download', { url });
        const response = await fetch(url, {
            headers: authorization ? {'Authorization': authorization} : {}
        });

        if (!response.ok) {
            const error = new Error(`Download failed: ${response.statusText}`);
            error.statusCode = response.status;
            throw error;
        }

        // Generate unique filename using SHA1 (hash) of file contents
        const buffer = await response.buffer();
        const sha = crypto.createHash('sha1').update(buffer).digest('hex');
        const originalName = url.split('/').pop();
        const sanitizedFileName = sanitizeFileName(originalName);
        const fileName = `${sha}_${sanitizedFileName}`;

        // Upload to S3 storage
        logger.debug(`Uploading: ${fileName}`);
        const uploadResult = await uploadToStorage('s/v3', fileName, buffer, response.headers.get('content-type'));
        if (uploadResult.success === false) {
            throw new Error(`Storage upload failed: ${uploadResult.error}`);
        }

        return {
            url: generateUrl('s/v3', fileName),
            sha,
            size: buffer.length,
            type: response.headers.get('content-type')
        };
    } catch (error) {
        logger.error('Upload process failed', {
            url,
            error: error.message,
            statusCode: error.statusCode,
            stack: error.stack
        });
        
        // Format error (pain)
        const statusCode = error.statusCode || 500;
        const errorResponse = {
            error: {
                message: error.message,
                code: error.code || 'INTERNAL_ERROR',
                details: error.details || null
            },
            success: false
        };

        throw { statusCode, ...errorResponse };
    }
};

// Express request handler for file uploads
const handleUpload = async (req) => {
    try {
        const url = req.body || await req.text();
        const result = await uploadEndpoint(url, req.headers?.authorization);
        return { status: 200, body: result };
    } catch (error) {
        return {
            status: error.statusCode || 500,
            body: {
                error: error.error || {
                    message: 'Internal server error',
                    code: 'INTERNAL_ERROR'
                },
                success: false
            }
        };
    }
};

module.exports = {uploadEndpoint, handleUpload};
