export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

export function rgbToRgb(rgb: string): { r: number; g: number; b: number } | null {
  const result = rgb.match(/\d+/g);
  return result && result.length >= 3
    ? {
        r: parseInt(result[0]),
        g: parseInt(result[1]),
        b: parseInt(result[2]),
      }
    : null;
}

export function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function getContrastRatio(
  rgb1: { r: number; g: number; b: number },
  rgb2: { r: number; g: number; b: number }
): number {
  const lum1 = getLuminance(rgb1.r, rgb1.g, rgb1.b);
  const lum2 = getLuminance(rgb2.r, rgb2.g, rgb2.b);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

export function parseColor(color: string): { r: number; g: number; b: number } | null {
  if (!color) return null;
  
  if (color.startsWith('#')) {
    return hexToRgb(color);
  } else if (color.startsWith('rgb')) {
    return rgbToRgb(color);
  }
  
  return null;
}

export function ensureContrast(
  bgColor: string | undefined,
  textColor: string | undefined,
  minContrast: number = 4.5
): { backgroundColor: string; color: string } {
  const defaultBg = '#ffffff';
  const defaultText = '#000000';
  
  if (!bgColor || !textColor) {
    return { backgroundColor: bgColor || defaultBg, color: textColor || defaultText };
  }
  
  const bg = parseColor(bgColor);
  const text = parseColor(textColor);
  
  if (!bg || !text) {
    return { backgroundColor: bgColor, color: textColor };
  }
  
  const contrast = getContrastRatio(bg, text);
  
  if (contrast >= minContrast) {
    return { backgroundColor: bgColor, color: textColor };
  }
  
  // If contrast is too low, determine if we need light or dark text
  const bgLuminance = getLuminance(bg.r, bg.g, bg.b);
  const needsLightText = bgLuminance < 0.5;
  
  return {
    backgroundColor: bgColor,
    color: needsLightText ? '#ffffff' : '#000000',
  };
}

export function getOverlayStyles(pane: any) {
  const { backgroundColor, color } = ensureContrast(
    pane?.backgroundColor,
    pane?.textColor,
    7 // Higher contrast for UI elements
  );
  
  // Parse background color for overlay effect
  const bg = parseColor(backgroundColor);
  const overlayOpacity = bg ? 0.95 : 0.98;
  
  return {
    backgroundColor: bg 
      ? `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${overlayOpacity})`
      : backgroundColor,
    color,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  };
}