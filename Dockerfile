FROM denoland/deno:alpine-1.38.0

# Install ffmpeg and yt-dlp
RUN apk add --no-cache ffmpeg wget && \
    wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /app

# Copy all files
COPY . .

# Cache the main file
RUN deno cache supabase/functions/download-video/index.ts

# Expose the default Deno port (change if needed)
EXPOSE 8000

# Run the server
CMD ["run", "--allow-net", "--allow-run", "--allow-read", "--allow-write", "supabase/functions/download-video/index.ts"]
