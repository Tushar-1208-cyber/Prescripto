import multer from "multer";
import path from "path";
import crypto from "crypto";
import os from "os";
import fs from "fs";

// Maximum file size: 5MB default, configurable via env
const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE
    ? parseInt(process.env.MAX_FILE_SIZE, 10)
    : 5 * 1024 * 1024; // 5 MB

// Allowed MIME types genuinely needed by the application (profile photos & medical documents/PDFs)
const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf'
]);

// Allowed file extensions (strictly lower-cased)
const ALLOWED_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.pdf'
]);

/**
 * Validate actual file contents against known binary signatures (magic bytes).
 * Prevents executable/script uploads masked with valid extensions.
 */
function validateFileSignature(filePath, expectedExtension) {
    let fd = null;
    try {
        if (!fs.existsSync(filePath)) return false;

        const buffer = Buffer.alloc(16);
        fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
        if (bytesRead < 4) {
            return false;
        }

        const ext = expectedExtension.toLowerCase();

        // JPEG: FF D8 FF
        if (ext === '.jpg' || ext === '.jpeg') {
            return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
        }

        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (ext === '.png') {
            return bytesRead >= 8 &&
                   buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
                   buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A;
        }

        // GIF: GIF87a or GIF89a (47 49 46 38)
        if (ext === '.gif') {
            return buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
        }

        // WEBP: RIFF (bytes 0-3) ... WEBP (bytes 8-11)
        if (ext === '.webp') {
            const isRiff = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
            const isWebp = bytesRead >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
            return isRiff && isWebp;
        }

        // PDF: %PDF (25 50 44 46)
        if (ext === '.pdf') {
            return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
        }

        return false;
    } catch {
        return false;
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {}
        }
    }
}

/**
 * Validates all files uploaded in a request.
 * If any file fails magic byte validation, cleans up all files from disk and returns false.
 */
function validateUploadedFiles(req) {
    const filesToValidate = [];
    if (req.file) {
        filesToValidate.push(req.file);
    } else if (Array.isArray(req.files)) {
        filesToValidate.push(...req.files);
    } else if (req.files && typeof req.files === 'object') {
        for (const field of Object.keys(req.files)) {
            if (Array.isArray(req.files[field])) {
                filesToValidate.push(...req.files[field]);
            }
        }
    }

    for (const f of filesToValidate) {
        const ext = path.extname(f.originalname || '').toLowerCase();
        if (!validateFileSignature(f.path, ext)) {
            // Delete all uploaded files to prevent leftover malicious files on disk
            for (const fileToDelete of filesToValidate) {
                try {
                    if (fileToDelete?.path && fs.existsSync(fileToDelete.path)) {
                        fs.unlinkSync(fileToDelete.path);
                    }
                } catch {}
            }
            return false;
        }
    }
    return true;
}

/**
 * Storage configuration:
 * Uses OS temporary directory and generates unique, cryptographically random filenames.
 * Completely eliminates path traversal, filename injection, and file collisions.
 */
const storage = multer.diskStorage({
    destination: function (req, file, callback) {
        callback(null, os.tmpdir());
    },
    filename: function (req, file, callback) {
        const rawExt = path.extname(file.originalname || '').toLowerCase();
        const ext = ALLOWED_EXTENSIONS.has(rawExt) ? rawExt : '.bin';
        const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
        const safeName = `upload-${uniqueSuffix}${ext}`;
        callback(null, safeName);
    }
});

/**
 * File filter:
 * Validates extension and MIME type upfront before streaming full content.
 */
const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();

    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
        return cb(new Error("Unsupported file extension. Allowed formats: .jpg, .jpeg, .png, .webp, .gif, .pdf"));
    }

    if (!ALLOWED_MIME_TYPES.has(mime)) {
        return cb(new Error("Unsupported file MIME type. Allowed formats: image/jpeg, image/png, image/webp, image/gif, application/pdf"));
    }

    cb(null, true);
};

// Base Multer instance with strict limits and filtering
const upload = multer({
    storage: storage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1
    },
    fileFilter: fileFilter
});

/**
 * Middleware wrapper that catches Multer errors and validates file signatures post-upload.
 * Guarantees controlled 400 responses without exposing internal filesystem paths or crashing.
 */
const wrapMiddleware = (multerFn) => {
    return (req, res, next) => {
        multerFn(req, res, (err) => {
            if (err) {
                // Clean up any partial/temporary files
                if (req.file?.path) {
                    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
                }
                if (req.files) {
                    const list = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
                    for (const f of list) {
                        try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
                    }
                }

                if (err instanceof multer.MulterError) {
                    if (err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(400).json({
                            success: false,
                            message: `File size exceeds the allowed limit of ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB`
                        });
                    }
                    return res.status(400).json({
                        success: false,
                        message: `Upload error: ${err.message}`
                    });
                }

                return res.status(400).json({
                    success: false,
                    message: err.message || 'File upload rejected'
                });
            }

            // Post-upload verification: Validate file magic bytes
            if (!validateUploadedFiles(req)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid file content: file signature does not match permitted file types"
                });
            }

            next();
        });
    };
};

/**
 * Transparent proxy preserving Multer API compatibility (upload.single, upload.array, etc.)
 */
const wrappedUpload = new Proxy(upload, {
    get(target, prop, receiver) {
        if (prop === 'single') {
            return (fieldName) => wrapMiddleware(target.single(fieldName));
        }
        if (prop === 'array') {
            return (fieldName, maxCount) => wrapMiddleware(target.array(fieldName, maxCount));
        }
        if (prop === 'fields') {
            return (fields) => wrapMiddleware(target.fields(fields));
        }
        if (prop === 'any') {
            return () => wrapMiddleware(target.any());
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
    }
});

export default wrappedUpload;
