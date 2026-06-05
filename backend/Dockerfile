FROM python:3.11-slim-bookworm

WORKDIR /app

# System deps: OpenCV, cairosvg, potrace (optional SVG tracing), Hebrew fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf2.0-0 \
    libffi-dev \
    potrace \
    fonts-dejavu \
    fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create static/sample_pages dir so the mount succeeds even with no uploads
RUN mkdir -p static/sample_pages

EXPOSE 8000

# Production: Gunicorn manages multiple uvicorn workers for true concurrency.
# - WEB_CONCURRENCY env (default 2) sets worker count.
# - --max-requests 1000 recycles workers to bound memory growth (OpenCV/PIL leaks).
# - --graceful-timeout 30 lets in-flight requests finish during Railway redeploys.
# - Logs to stdout/stderr so Railway captures them.
CMD ["sh", "-c", "gunicorn main:app -k uvicorn.workers.UvicornWorker -w ${WEB_CONCURRENCY:-2} --bind 0.0.0.0:${PORT:-8000} --timeout 300 --graceful-timeout 60 --max-requests 1000 --max-requests-jitter 100 --access-logfile - --error-logfile - --preload"]
