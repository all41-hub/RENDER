import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Cache for 5 minutes
const cache = new NodeCache({ stdTTL: 300 });

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://viralclipsaver.com', 'https://viralclipsaver.netlify.app']
    : ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 100 : 1000, // requests per window
  message: {
    error: 'Too many requests, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// Promisify exec for async/await
const execAsync = promisify(exec);

// Supported platforms
const SUPPORTED_PLATFORMS = [
  { name: 'YouTube', pattern: /(?:youtube\.com|youtu\.be)/, extractors: ['yt-dlp'] },
  { name: 'TikTok', pattern: /tiktok\.com/, extractors: ['yt-dlp', 'tiktok-scraper'] },
  { name: 'Instagram', pattern: /instagram\.com/, extractors: ['yt-dlp', 'insta-scraper'] },
  { name: 'Facebook', pattern: /facebook\.com/, extractors: ['yt-dlp', 'fb-scraper'] },
  { name: 'X (Twitter)', pattern: /(?:twitter\.com|x\.com)/, extractors: ['yt-dlp', 'twitter-scraper'] }
];

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Main video extraction endpoint
app.post('/api/download', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { videoUrl, format = 'mp4', quality = 'best' } = req.body;

    if (!videoUrl) {
      return res.status(400).json({
        error: 'videoUrl is required',
        example: { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
      });
    }

    // Check cache first
    const cacheKey = `${videoUrl}-${format}-${quality}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`✅ Cache hit for ${videoUrl}`);
      return res.json({
        ...cached,
        cached: true,
        responseTime: Date.now() - startTime
      });
    }

    // Detect platform
    const platform = detectPlatform(videoUrl);
    if (!platform) {
      return res.status(400).json({
        error: 'Unsupported platform',
        supported: SUPPORTED_PLATFORMS.map(p => p.name),
        provided: videoUrl
      });
    }

    console.log(`🎯 Extracting ${platform} video: ${videoUrl}`);

    // Extract video data using yt-dlp
    const videoData = await extractWithYtDlp(videoUrl, format, quality);
    
    // Cache the result
    cache.set(cacheKey, videoData);

    const responseTime = Date.now() - startTime;
    console.log(`✅ Extraction completed in ${responseTime}ms`);

    res.json({
      ...videoData,
      platform,
      cached: false,
      responseTime
    });

  } catch (error) {
    console.error('❌ Extraction failed:', error.message);
    
    const responseTime = Date.now() - startTime;
    
    res.status(500).json({
      error: error.message || 'Failed to extract video data',
      platform: detectPlatform(req.body.videoUrl),
      responseTime,
      troubleshooting: {
        commonIssues: [
          'Video may be private or deleted',
          'Platform may have changed their API',
          'Geographic restrictions may apply',
          'Video may be age-restricted'
        ],
        suggestions: [
          'Try a different video URL',
          'Check if the video is publicly accessible',
          'Wait a few minutes and try again'
        ]
      }
    });
  }
});

// Get video info without download links (faster)
app.post('/api/info', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { videoUrl } = req.body;

    if (!videoUrl) {
      return res.status(400).json({
        error: 'videoUrl is required'
      });
    }

    const platform = detectPlatform(videoUrl);
    if (!platform) {
      return res.status(400).json({
        error: 'Unsupported platform',
        supported: SUPPORTED_PLATFORMS.map(p => p.name)
      });
    }

    // Get basic info only (no download URLs)
    const videoInfo = await getVideoInfo(videoUrl);
    
    const responseTime = Date.now() - startTime;

    res.json({
      ...videoInfo,
      platform,
      responseTime
    });

  } catch (error) {
    console.error('❌ Info extraction failed:', error.message);
    
    res.status(500).json({
      error: error.message || 'Failed to get video info',
      responseTime: Date.now() - startTime
    });
  }
});

// List supported platforms
app.get('/api/platforms', (req, res) => {
  res.json({
    supported: SUPPORTED_PLATFORMS.map(p => ({
      name: p.name,
      pattern: p.pattern.toString(),
      extractors: p.extractors
    })),
    total: SUPPORTED_PLATFORMS.length
  });
});

// Extract video data using yt-dlp
async function extractWithYtDlp(videoUrl, format = 'mp4', quality = 'best') {
  return new Promise((resolve, reject) => {
    // yt-dlp command with JSON output
    const args = [
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      '--extract-flat',
      videoUrl
    ];

    const ytdlp = spawn('yt-dlp', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', async (code) => {
      if (code !== 0) {
        console.error('yt-dlp stderr:', stderr);
        reject(new Error(`yt-dlp failed: ${stderr || 'Unknown error'}`));
        return;
      }

      try {
        const videoInfo = JSON.parse(stdout);
        
        // Now get the actual download URLs
        const formats = await getDownloadFormats(videoUrl, format, quality);
        
        const result = {
          title: videoInfo.title || 'Unknown Title',
          thumbnail: videoInfo.thumbnail || videoInfo.thumbnails?.[0]?.url || '',
          duration: formatDuration(videoInfo.duration || 0),
          uploader: videoInfo.uploader || videoInfo.channel || '',
          view_count: videoInfo.view_count || 0,
          upload_date: videoInfo.upload_date || '',
          formats: formats
        };

        resolve(result);
      } catch (parseError) {
        reject(new Error(`Failed to parse yt-dlp output: ${parseError.message}`));
      }
    });

    ytdlp.on('error', (error) => {
      reject(new Error(`Failed to spawn yt-dlp: ${error.message}`));
    });
  });
}

// Get download formats using yt-dlp
async function getDownloadFormats(videoUrl, preferredFormat = 'mp4', preferredQuality = 'best') {
  return new Promise((resolve, reject) => {
    const args = [
      '--list-formats',
      '--dump-json',
      '--no-warnings',
      videoUrl
    ];

    const ytdlp = spawn('yt-dlp', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Format listing failed: ${stderr}`));
        return;
      }

      try {
        // Parse each line as JSON (yt-dlp outputs one JSON per line)
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        const videoData = JSON.parse(lines[lines.length - 1]); // Last line has the main data
        
        const formats = [];
        
        if (videoData.formats) {
          // Process video formats
          const videoFormats = videoData.formats
            .filter(f => f.vcodec && f.vcodec !== 'none' && f.url)
            .sort((a, b) => (b.height || 0) - (a.height || 0));

          for (const format of videoFormats) {
            if (format.height) {
              formats.push({
                quality: `${format.height}p`,
                format: 'mp4',
                url: await getDirectDownloadUrl(videoUrl, format.format_id),
                size: format.filesize ? formatBytes(format.filesize) : 'Unknown',
                fps: format.fps || 30,
                vcodec: format.vcodec,
                acodec: format.acodec
              });
            }
          }

          // Process audio formats
          const audioFormats = videoData.formats
            .filter(f => f.acodec && f.acodec !== 'none' && !f.vcodec && f.url)
            .sort((a, b) => (b.abr || 0) - (a.abr || 0));

          if (audioFormats.length > 0) {
            const bestAudio = audioFormats[0];
            formats.push({
              quality: 'audio',
              format: 'mp3',
              url: await getDirectDownloadUrl(videoUrl, bestAudio.format_id),
              size: bestAudio.filesize ? formatBytes(bestAudio.filesize) : 'Unknown',
              abr: bestAudio.abr || 128,
              acodec: bestAudio.acodec
            });
          }
        }

        resolve(formats);
      } catch (parseError) {
        reject(new Error(`Failed to parse format data: ${parseError.message}`));
      }
    });

    ytdlp.on('error', (error) => {
      reject(new Error(`Failed to get formats: ${error.message}`));
    });
  });
}

// Get direct download URL for a specific format
async function getDirectDownloadUrl(videoUrl, formatId) {
  try {
    const { stdout } = await execAsync(`yt-dlp --get-url -f ${formatId} "${videoUrl}"`);
    return stdout.trim();
  } catch (error) {
    console.error(`Failed to get direct URL for format ${formatId}:`, error.message);
    return null;
  }
}

// Get basic video info (faster, no download URLs)
async function getVideoInfo(videoUrl) {
  const { stdout } = await execAsync(`yt-dlp --dump-json --no-download "${videoUrl}"`);
  const videoInfo = JSON.parse(stdout);
  
  return {
    title: videoInfo.title || 'Unknown Title',
    thumbnail: videoInfo.thumbnail || videoInfo.thumbnails?.[0]?.url || '',
    duration: formatDuration(videoInfo.duration || 0),
    uploader: videoInfo.uploader || videoInfo.channel || '',
    view_count: videoInfo.view_count || 0,
    upload_date: videoInfo.upload_date || ''
  };
}

// Detect platform from URL
function detectPlatform(url) {
  try {
    const urlObj = new URL(url);
    const platform = SUPPORTED_PLATFORMS.find(p => p.pattern.test(urlObj.hostname));
    return platform?.name || null;
  } catch {
    return null;
  }
}

// Format duration from seconds to MM:SS or HH:MM:SS
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '0:00';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Format bytes to human readable
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: [
      'POST /api/download - Extract video with download links',
      'POST /api/info - Get video info only',
      'GET /api/platforms - List supported platforms',
      'GET /health - Health check'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Video Downloader API running on port ${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`🎥 API endpoint: http://localhost:${PORT}/api/download`);
  
  // Check if yt-dlp is available
  exec('yt-dlp --version', (error, stdout) => {
    if (error) {
      console.warn('⚠️  yt-dlp not found. Please install it: pip install yt-dlp');
    } else {
      console.log(`✅ yt-dlp version: ${stdout.trim()}`);
    }
  });
});

export default app;
