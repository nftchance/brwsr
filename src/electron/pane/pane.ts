import { BaseWindow, WebContentsView } from "electron";

import { Leaf, Rect } from "./types";

import path from "path";
import fs from "fs";

const devUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
const isDev = !!process.env.ELECTRON_START_URL;

export class Pane {
  window: BaseWindow;

  id: number;
  leaf: Leaf;
  rect: Rect | null;

  constructor(win: BaseWindow, leaf: Leaf, rect: Rect | null = null) {
    this.window = win;

    this.id = leaf.id;
    this.leaf = leaf;
    this.rect = rect;

    const overlay = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:default",
        additionalArguments: [`--paneId=${leaf.id}`],
      },
    });
    overlay.setBackgroundColor("#00000000");
    if (isDev) {
      overlay.webContents.loadURL(devUrl);
    } else {
      const distIndex = path.join(__dirname, "..", "dist", "index.html");
      if (!fs.existsSync(distIndex)) {
        throw new Error(
          `Renderer not built: ${distIndex} missing. Run "pnpm build".`
        );
      }
      overlay.webContents.loadFile(distIndex);
    }
    this.window.contentView.addChildView(overlay);
    overlay.setBounds(rect ?? { x: 0, y: 0, width: 1200, height: 600 });

    this.window.contentView.addChildView(leaf.view);

    this.leaf.layers = [overlay, leaf.view];
  }

  reverse = () => {
    const layers = this.leaf.layers ?? [];
    layers.reverse();
    for (const layer of layers) {
      this.window.contentView.addChildView(layer);
    }

    this.leaf.layers = layers;

    layers[1].webContents.focus();
    layers[1].webContents.send(
      "pane:overlay:focus",
      this.leaf.url === layers[0].webContents.getURL()
    );
  };

  navigate = (url: string) => {
    this.leaf.url = url;
    this.leaf.view.webContents.loadURL(url);
  };

  close = () => {
    for (const layer of this.leaf.layers ?? []) {
      this.window.contentView.removeChildView(layer);
    }
  };

  html = async (): Promise<string> => {
    return await this.leaf.view.webContents.executeJavaScript(`
        document.documentElement.outerHTML
    `);
  };

  backgroundColor = async (): Promise<string> => {
    return await this.leaf.view.webContents.executeJavaScript(`
        (() => {
          const selectors = [
            'body',
            'main',
            'article',
            '.content',
            '.main-content',
            '#content',
            '#main',
            'html',
            'document.documentElement'
          ];
          
          for (const selector of selectors) {
            let element;
            if (selector === 'document.documentElement') {
              element = document.documentElement;
            } else {
              element = document.querySelector(selector);
            }
            
            if (element) {
              const computedStyle = window.getComputedStyle(element);
              const bgColor = computedStyle.backgroundColor;
              
              // Skip transparent, inherit, or default colors
              if (bgColor && 
                  bgColor !== 'rgba(0, 0, 0, 0)' && 
                  bgColor !== 'transparent' && 
                  bgColor !== 'inherit' &&
                  bgColor !== 'rgb(255, 255, 255)' && // Skip pure white as it's often default
                  bgColor !== '#ffffff' &&
                  bgColor !== '#fff') {
                return bgColor;
              }
            }
          }
          
          // Fallback to document element background
          const docStyle = window.getComputedStyle(document.documentElement);
          const docBgColor = docStyle.backgroundColor;
          
          return docBgColor && docBgColor !== 'rgba(0, 0, 0, 0)' ? docBgColor : '';
        })()
    `);
  };

  favicon = async (): Promise<string> => {
    const currentUrl = this.leaf.view.webContents.getURL();

    const pageFavicon = await this.leaf.view.webContents.executeJavaScript(`
        (() => {
          const selectors = [
            'link[rel="icon"]',
            'link[rel="shortcut icon"]',
            'link[rel="apple-touch-icon"]',
            'link[rel="apple-touch-icon-precomposed"]'
          ];
          
          for (const selector of selectors) {
            const link = document.querySelector(selector);
            if (link && link.href) {
              return link.href;
            }
          }
          
          return null;
        })()
    `);

    if (pageFavicon) {
      return pageFavicon;
    }

    try {
      const url = new URL(currentUrl);
      return `${url.protocol}//${url.host}/favicon.ico`;
    } catch {
      return "";
    }
  };

  description = async (): Promise<string> => {
    return await this.leaf.view.webContents.executeJavaScript(`
        document.querySelector('meta[name="description"]')?.content || ''
   `);
  };

  image = async (): Promise<string> => {
    return await this.leaf.view.webContents.executeJavaScript(`
        (() => {
          // Try multiple image selectors in order of preference
          const selectors = [
            'meta[property="og:image"]',
            'meta[name="twitter:image"]',
            'meta[property="twitter:image"]',
            'meta[name="image"]',
            'meta[property="image"]'
          ];
          
          for (const selector of selectors) {
            const meta = document.querySelector(selector);
            if (meta && meta.content) {
              return meta.content;
            }
          }
          
          return '';
        })()
    `);
  };

  textColor = async (): Promise<string> => {
    return await this.leaf.view.webContents.executeJavaScript(`
        (() => {
          const selectors = [
            'body',
            'main',
            'article',
            'h1',
            'h2',
            'h3',
            'p',
            '.content',
            '.main-content',
            '#content',
            '#main'
          ];
          
          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
              const computedStyle = window.getComputedStyle(element);
              const color = computedStyle.color;
              
              if (color && 
                  color !== 'rgba(0, 0, 0, 0)' && 
                  color !== 'transparent' && 
                  color !== 'inherit' &&
                  color !== 'rgb(0, 0, 0)' && // Skip pure black as it's often default
                  color !== '#000000') {
                return color;
              }
            }
          }
          
          const bodyStyle = window.getComputedStyle(document.body);
          const bodyColor = bodyStyle.color;
          
          return bodyColor && bodyColor !== 'rgba(0, 0, 0, 0)' ? bodyColor : '';
        })()
    `);
  };
}
