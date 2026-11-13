const { createCanvas, Image } = require('canvas');
const { encodeQR, decodeQR } = require('../src/qrcode');

// Test encodeQR
console.log('Testing encodeQR...');
try {
  const result1 = encodeQR('test data', 'base64');
  console.log('Base64 result:', result1.substring(0, 50) + '...');
  
  const result2 = encodeQR('test data', 'base16');
  console.log('Base16 result:', result2.substring(0, 50) + '...');
  
  console.log('encodeQR tests passed');
} catch (error) {
  console.error('encodeQR test failed:', error);
}

// Test decodeQR - this is more complex as it requires a real image
console.log('Testing decodeQR...');
try {
  // Create a canvas with some image data
  const canvas = createCanvas(21, 21);
  const ctx = canvas.getContext('2d');
  
  // Create a simple image with black pixels forming a QR-like pattern
  const imageData = ctx.createImageData(21, 21);
  for (let i = 0; i < imageData.data.length; i++) {
    // Make all pixels black for testing
    imageData.data[i] = 0;
    imageData.data[i + 1] = 0;
    imageData.data[i + 2] = 0;
    imageData.data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  
  // Test decodeQR
  const result = decodeQR(imageData);
  if (result) {
    console.log('decodeQR result:', result);
  } else {
    console.log('decodeQR returned null (no QR code found)');
  }
  
  console.log('decodeQR test completed');
} catch (error) {
  console.error('decodeQR test failed:', error);
}