export async function getDominantColor(imageUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve('#000000');
                    return;
                }
                
                const scaleFactor = 50;
                canvas.width = scaleFactor;
                canvas.height = scaleFactor;
                
                ctx.drawImage(img, 0, 0, scaleFactor, scaleFactor);
                const imageData = ctx.getImageData(0, 0, scaleFactor, scaleFactor);
                const data = imageData.data;
                
                const colorMap: { [key: string]: number } = {};
                
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const a = data[i + 3];
                    
                    if (a < 125) continue;
                    
                    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
                    if (brightness > 245 || brightness < 10) continue;
                    
                    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
                    if (saturation < 20) continue;
                    
                    const colorKey = `${Math.round(r/10)*10},${Math.round(g/10)*10},${Math.round(b/10)*10}`;
                    colorMap[colorKey] = (colorMap[colorKey] || 0) + 1;
                }
                
                let maxCount = 0;
                let dominantColor = '#000000';
                
                for (const [color, count] of Object.entries(colorMap)) {
                    if (count > maxCount) {
                        maxCount = count;
                        const [r, g, b] = color.split(',').map(Number);
                        dominantColor = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
                    }
                }
                
                resolve(dominantColor);
            } catch (error) {
                console.error('Error calculating dominant color:', error);
                resolve('#000000');
            }
        };
        
        img.onerror = () => {
            console.error('Failed to load image:', imageUrl);
            resolve('#000000');
        };
        
        img.src = imageUrl;
    });
}