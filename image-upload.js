// Image Upload Feature - Add to your project

// 1. Install Cloudinary
// npm install cloudinary multer

// 2. Add to .env
/*
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
*/

// 3. Create config/cloudinary.js
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only images allowed'));
        }
    }
});

async function uploadToCloudinary(buffer) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'realtorfinder' },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        uploadStream.end(buffer);
    });
}

module.exports = { upload, uploadToCloudinary };

// 4. Add route to server.js
/*
const { upload, uploadToCloudinary } = require('./config/cloudinary');

// Upload images for listing
app.post('/api/listings/:id/images', upload.array('images', 5), async (req, res) => {
    try {
        const imageUrls = [];

        for (const file of req.files) {
            const result = await uploadToCloudinary(file.buffer);
            imageUrls.push(result.secure_url);
        }

        // Update listing with image URLs
        await pool.query(
            'UPDATE listings SET image_urls = $1 WHERE id = $2',
            [imageUrls, req.params.id]
        );

        res.json({ success: true, imageUrls });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload images' });
    }
});
*/

// 5. Update frontend - Add to listing form in index.html
/*
<div class="form-group">
    <label>Property Photos (up to 5)</label>
    <input type="file" name="images" accept="image/*" multiple id="imageInput">
    <div id="imagePreview"></div>
</div>
*/

// 6. Add to app.js for image preview
/*
document.getElementById('imageInput')?.addEventListener('change', (e) => {
    const preview = document.getElementById('imagePreview');
    preview.innerHTML = '';

    Array.from(e.target.files).forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = document.createElement('img');
            img.src = e.target.result;
            img.style.width = '100px';
            img.style.margin = '5px';
            preview.appendChild(img);
        };
        reader.readAsDataURL(file);
    });
});
*/
