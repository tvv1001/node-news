'use client';

import React, { useEffect, useState } from 'react';

// Default values
const DEFAULT_COLOR = '#2563eb';
const DEFAULT_DARKNESS = 80;

export default function ThemeSettings() {
  const [isOpen, setIsOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [accentColor, setAccentColor] = useState(DEFAULT_COLOR);
  const [darkness, setDarkness] = useState(DEFAULT_DARKNESS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Load saved settings on mount
    const savedDark = localStorage.getItem('theme-dark') === 'true';
    const savedColor = localStorage.getItem('theme-accent') || DEFAULT_COLOR;
    const savedDarkness = parseInt(localStorage.getItem('theme-darkness') || String(DEFAULT_DARKNESS), 10);
    
    setIsDark(savedDark);
    setAccentColor(savedColor);
    setDarkness(savedDarkness);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    localStorage.setItem('theme-dark', String(isDark));
    localStorage.setItem('theme-accent', accentColor);
    localStorage.setItem('theme-darkness', String(darkness));

    const root = document.documentElement;

    // Helper to convert hex to rgb for rgba calculations
    const hexToRgb = (hex: string) => {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '37, 99, 235';
    };

    const accentRgb = hexToRgb(accentColor);
    
    root.style.setProperty('--accent', accentColor);
    root.style.setProperty('--accent-strong', accentColor); // Simplifying strong accent
    root.style.setProperty('--accent-bg', `rgba(${accentRgb}, 0.1)`);
    root.style.setProperty('--accent-border', `rgba(${accentRgb}, 0.22)`);

    if (isDark) {
      root.style.setProperty('color-scheme', 'dark');
      
      // Calculate background lightness based on darkness level (0 to 100)
      // 100 darkness -> lightness 5%
      // 0 darkness -> lightness 25%
      const bgLightness = 25 - (darkness * 0.2); 
      const surfaceLightness = bgLightness + 5;
      const borderLightness = bgLightness + 15;

      root.style.setProperty('--bg', `hsl(217, 33%, ${bgLightness}%)`);
      root.style.setProperty('--surface', `hsla(217, 33%, ${surfaceLightness}%, 0.8)`);
      root.style.setProperty('--surface-solid', `hsl(217, 33%, ${surfaceLightness}%)`);
      root.style.setProperty('--border', `hsl(217, 33%, ${borderLightness}%)`);
      root.style.setProperty('--border-strong', `hsl(217, 33%, ${borderLightness + 10}%)`);
      
      root.style.setProperty('--text', '#cbd5e1'); // text-slate-300
      root.style.setProperty('--text-h', '#f8fafc'); // text-slate-50
      root.style.setProperty('--text-m', '#94a3b8'); // text-slate-400
      root.style.setProperty('--code-bg', `hsl(217, 33%, ${bgLightness - 2}%)`);
      root.style.setProperty('--social-bg', `rgba(255, 255, 255, 0.06)`);
    } else {
      root.style.setProperty('color-scheme', 'light');
      
      // Reset to light mode defaults from style.css
      root.style.setProperty('--bg', '#f6f8fc');
      root.style.setProperty('--surface', 'rgba(255, 255, 255, 0.8)');
      root.style.setProperty('--surface-solid', '#ffffff');
      root.style.setProperty('--border', '#dbe4f0');
      root.style.setProperty('--border-strong', '#c8d4e4');
      root.style.setProperty('--text', '#5f6571');
      root.style.setProperty('--text-h', '#0f172a');
      root.style.setProperty('--text-m', '#6b7280');
      root.style.setProperty('--code-bg', '#eef4ff');
      root.style.setProperty('--social-bg', 'rgba(37, 99, 235, 0.06)');
    }
  }, [isDark, accentColor, darkness, mounted]);

  if (!mounted) return null;

  return (
    <div style={{ position: 'fixed', bottom: '20px', right: '20px', zIndex: 9999 }}>
      {isOpen ? (
        <div style={{
          background: 'var(--surface-solid)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '16px',
          boxShadow: 'var(--shadow)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          width: '280px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--text-h)' }}>Theme Settings</h3>
            <button 
              onClick={() => setIsOpen(false)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-m)'
              }}
            >
              ✕
            </button>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input 
              type="checkbox" 
              checked={isDark} 
              onChange={e => setIsDark(e.target.checked)} 
            />
            Dark Mode
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            Accent Color
            <input 
              type="color" 
              value={accentColor} 
              onChange={e => setAccentColor(e.target.value)} 
              style={{ width: '100%', height: '32px', cursor: 'pointer', padding: '0', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
            />
          </label>

          {isDark && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              Darkness Level ({darkness})
              <input 
                type="range" 
                min="0" 
                max="100" 
                value={darkness} 
                onChange={e => setDarkness(parseInt(e.target.value, 10))} 
                style={{ width: '100%' }}
              />
            </label>
          )}

          <button 
            onClick={() => {
              setIsDark(false);
              setAccentColor(DEFAULT_COLOR);
              setDarkness(DEFAULT_DARKNESS);
            }}
            style={{
              padding: '8px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              cursor: 'pointer',
              color: 'var(--text)'
            }}
          >
            Reset to Defaults
          </button>
        </div>
      ) : (
        <button 
          onClick={() => setIsOpen(true)}
          style={{
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            background: 'var(--surface-solid)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-h)'
          }}
          title="Theme Settings"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" />
          </svg>
        </button>
      )}
    </div>
  );
}
