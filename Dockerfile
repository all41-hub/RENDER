# Use official Deno image
FROM denoland/deno:alpine-1.38.0

# Install ffmpeg and yt-dlp
RUN apk add --no-cache ffmpeg wget && \
    wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /app

# Copy app files
COPY . .

# Cache Deno dependencies (optional, for speed)
RUN deno cache server.ts

# Expose app port (if needed)
EXPOSE 8000

# Run your Deno app with permissions
CMD ["run", "--allow-net", "--allow-run", "--allow-read", "--allow-write", "server.ts"]
