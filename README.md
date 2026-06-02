# LinkedIn Video Upload Worker

A Cloudflare Worker that handles the full LinkedIn video upload flow — chunked upload, optional thumbnail, and optional post creation — all from a single API call.

## Features

- Chunked video upload via LinkedIn's multipart upload API
- Optional thumbnail upload
- Optional post creation after upload completes
- API key authentication
- Full CORS support

## Setup

```bash
npm install -g wrangler
wrangler deploy
wrangler secret put API_KEY
```

## API

**POST** `/`

### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `x-api-key` | Yes | Worker API key |
| `Authorization` | Yes | `Bearer <linkedin_access_token>` |
| `LinkedIn-Version` | No | API version (default: `202404`) |
| `X-RestLi-Protocol-Version` | No | Protocol version (default: `2.0.0`) |

### Request Body

```json
{
  "fileUrl": "https://example.com/video.mp4",
  "author": "urn:li:organization:123456789",
  "thumbnailUrl": "https://example.com/thumb.jpg",
  "postData": {
    "title": "My Video",
    "commentary": "Check this out!",
    "visibility": "PUBLIC",
    "feedDistribution": "MAIN_FEED"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `fileUrl` | Yes | Direct URL to the video file |
| `author` | Yes | LinkedIn URN (`urn:li:organization:ID` or `urn:li:person:ID`) |
| `thumbnailUrl` | No | Direct URL to thumbnail image |
| `postData` | No | If provided, creates a LinkedIn post after upload |

### Response

```json
{
  "success": true,
  "videoUrn": "urn:li:video:123456789",
  "fileSizeBytes": 15728640,
  "uploadPartIds": ["etag1", "etag2"],
  "thumbnail": { "success": true },
  "post": { "success": true, "postId": "post-id", "status": 201 }
}
```
