const API_BASE_URL = window.location.origin + '/api';
let currentListingId = null;
let selectedFiles = [];

async function fetchListings() {
    try {
        const response = await fetch(`${API_BASE_URL}/listings`);
        const listings = await response.json();
        renderListings(listings);
    } catch (error) {
        console.error('Error fetching listings:', error);
        showError('Failed to load listings. Please try again.');
    }
}

function renderListings(listings) {
    const grid = document.getElementById('listingsGrid');
    if (listings.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><div class="empty-state-icon">🏠</div><h3>No listings yet</h3><p>Be the first to list your property!</p></div>';
        return;
    }
    grid.innerHTML = listings.map(listing => {
        const imageUrl = listing.image_urls && listing.image_urls.length > 0 ? listing.image_urls[0] : null;
        return `<div class="listing-card" onclick="openOfferModal(${listing.id})"><div class="listing-image" style="${imageUrl ? `background-image: url(${imageUrl}); background-size: cover; background-position: center;` : ''}">${!imageUrl ? '🏡' : ''}</div><div class="listing-content"><div class="listing-price">${listing.price}</div><div class="listing-address">${listing.address}</div><div class="listing-details"><span>🛏️ ${listing.bedrooms} bd</span><span>🛁 ${listing.bathrooms} ba</span><span>📏 ${listing.sqft.toLocaleString()} sqft</span></div><div class="listing-description">${listing.description}</div><div class="listing-date">${listing.date}</div></div></div>`;
    }).join('');
}

function switchView(view) {
    document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
    document.getElementById(`${view}-view`).classList.add('active');
    document.querySelector(`[data-view="${view}"]`).classList.add('active');
}

function displayImagePreviews(files) {
    const preview = document.getElementById('imagePreview');
    preview.innerHTML = '';
    files.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const div = document.createElement('div');
            div.className = 'image-preview-item';
            div.innerHTML = `<img src="${e.target.result}" alt="Preview ${index + 1}"><button type="button" class="image-preview-remove" onclick="removeImage(${index})" title="Remove image">×</button>`;
            preview.appendChild(div);
        };
        reader.readAsDataURL(file);
    });
}

function removeImage(index) {
    selectedFiles.splice(index, 1);
    const dt = new DataTransfer();
    selectedFiles.forEach(file => dt.items.add(file));
    const imageInput = document.getElementById('imageInput');
    if (imageInput) imageInput.files = dt.files;
    const fileCount = document.getElementById('fileCount');
    if (fileCount) fileCount.textContent = selectedFiles.length > 0 ? `${selectedFiles.length} image${selectedFiles.length !== 1 ? 's' : ''} selected` : '';
    displayImagePreviews(selectedFiles);
}

document.getElementById('listingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Publishing...';
    submitBtn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const listingData = {
            address: formData.get('address'),
            price: formData.get('price'),
            type: formData.get('type'),
            bedrooms: formData.get('bedrooms'),
            bathrooms: formData.get('bathrooms'),
            sqft: formData.get('sqft'),
            description: formData.get('description'),
            ownerName: formData.get('ownerName'),
            ownerEmail: formData.get('ownerEmail'),
            ownerPhone: formData.get('ownerPhone')
        };
        const response = await fetch(`${API_BASE_URL}/listings`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(listingData)
        });
        if (!response.ok) throw new Error('Failed to create listing');
        const listing = await response.json();
        console.log('✅ Listing created:', listing);
        if (selectedFiles.length > 0) {
            submitBtn.textContent = `Uploading ${selectedFiles.length} photo${selectedFiles.length !== 1 ? 's' : ''}...`;
            const imageFormData = new FormData();
            selectedFiles.forEach(file => imageFormData.append('images', file));
            const imageResponse = await fetch(`${API_BASE_URL}/listings/${listing.id}/images`, {
                method: 'POST',
                body: imageFormData
            });
            if (!imageResponse.ok) {
                console.warn('⚠️ Image upload failed, but listing was created');
            } else {
                const imageResult = await imageResponse.json();
                console.log('✅ Images uploaded:', imageResult);
            }
        }
        await fetchListings();
        e.target.reset();
        selectedFiles = [];
        const imagePreview = document.getElementById('imagePreview');
        const fileCount = document.getElementById('fileCount');
        if (imagePreview) imagePreview.innerHTML = '';
        if (fileCount) fileCount.textContent = '';
        switchView('browse');
        showSuccess('🎉 Your listing has been published successfully!');
    } catch (error) {
        console.error('Error creating listing:', error);
        showError('Failed to publish listing. Please try again.');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
});

async function openOfferModal(listingId) {
    currentListingId = listingId;
    try {
        const response = await fetch(`${API_BASE_URL}/listings/${listingId}`);
        const listing = await response.json();
        const fullAddress = listing.city && listing.state ? `${listing.address}, ${listing.city}, ${listing.state} ${listing.zip || ''}`.trim() : listing.address;
        document.getElementById('modalPropertyAddress').textContent = fullAddress;
        document.getElementById('offerModal').classList.add('active');
    } catch (error) {
        console.error('Error fetching listing:', error);
        showError('Failed to load listing details.');
    }
}

function closeModal() {
    document.getElementById('offerModal').classList.remove('active');
    document.getElementById('offerForm').reset();
    document.getElementById('modalBody').innerHTML = '<h2 style="margin-bottom: 0.5rem;">Submit Offer Package</h2><p class="subtitle" id="modalPropertyAddress"></p><form id="offerForm"><div class="form-group"><label>Your Name *</label><input type="text" name="realtorName" placeholder="Jane Smith" required></div><div class="form-group"><label>Brokerage *</label><input type="text" name="brokerage" placeholder="Premier Realty Group" required></div><div class="form-row"><div class="form-group"><label>Email *</label><input type="email" name="realtorEmail" placeholder="jane@premierrealty.com" required></div><div class="form-group"><label>Phone *</label><input type="tel" name="realtorPhone" placeholder="(555) 987-6543" required></div></div><div class="form-group"><label>Commission Rate (%)</label><input type="number" name="commission" step="0.1" placeholder="5.0"></div><div class="form-group"><label>Your Offer Package Details *</label><textarea name="offerDetails" placeholder="Describe your marketing plan..." required></textarea></div><button type="submit" class="btn btn-primary btn-block">Submit Offer</button></form>';
    document.getElementById('offerForm').addEventListener('submit', handleOfferSubmit);
}

async function handleOfferSubmit(e) {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Submitting...';
    submitBtn.disabled = true;
    try {
        const formData = new FormData(e.target);
        const offerData = {
            realtorName: formData.get('realtorName'),
            brokerage: formData.get('brokerage'),
            realtorEmail: formData.get('realtorEmail'),
            realtorPhone: formData.get('realtorPhone'),
            commission: formData.get('commission'),
            offerDetails: formData.get('offerDetails')
        };
        const response = await fetch(`${API_BASE_URL}/listings/${currentListingId}/offers`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(offerData)
        });
        if (!response.ok) throw new Error('Failed to submit offer');
        document.getElementById('modalBody').innerHTML = '<div class="success-message"><h3 style="margin-bottom: 0.5rem;">✅ Offer Package Submitted!</h3><p style="opacity: 0.95;">Your offer has been sent to the homeowner.</p></div><button class="btn btn-primary btn-block" onclick="closeModal()">Done</button>';
    } catch (error) {
        console.error('Error submitting offer:', error);
        showError('Failed to submit offer. Please try again.');
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
}

function showSuccess(message) {
    alert(message);
}

function showError(message) {
    alert(message);
}

document.addEventListener('DOMContentLoaded', () => {
    fetchListings();
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });
    document.getElementById('offerModal').addEventListener('click', (e) => {
        if (e.target.id === 'offerModal') closeModal();
    });
    document.getElementById('offerForm').addEventListener('submit', handleOfferSubmit);
    const imageInput = document.getElementById('imageInput');
    if (imageInput) {
        imageInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            selectedFiles = files.slice(0, 10);
            const fileCount = document.getElementById('fileCount');
            if (fileCount) fileCount.textContent = selectedFiles.length > 0 ? `${selectedFiles.length} image${selectedFiles.length !== 1 ? 's' : ''} selected` : '';
            displayImagePreviews(selectedFiles);
        });
    }
});
