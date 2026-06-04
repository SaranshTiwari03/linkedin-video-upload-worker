export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return handleCORS();

    const apiKey = request.headers.get('x-api-key');
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized - Invalid or missing API key' }), {
        status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'Method not allowed. Please use POST.' }), {
          status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const { body, error: parseError } = await parseAndValidateRequest(request);
      if (parseError) return parseError;

      const { fileUrl, author, thumbnailUrl, mediaLibraryMetadata, uploadThumbnail, postData } = body;
      const headers = getRequestHeaders(request, body);
      if (!headers.authorization) {
        return new Response(JSON.stringify({ success: false, error: 'Missing LinkedIn access token.' }), {
          status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const { videoBuffer, fileSizeBytes, error: videoError } = await fetchVideoFile(fileUrl);
      if (videoError) return videoError;

      const { initializeResponseJson, videoUrn, uploadInstructions, uploadToken, thumbnailUploadUrl, error: initError } =
        await initializeVideoUpload(headers, author, fileSizeBytes, uploadThumbnail, mediaLibraryMetadata);
      if (initError) return initError;

      const { uploadPartIds, uploadResults, error: uploadError } =
        await uploadVideoChunks(uploadInstructions, videoBuffer, headers.authorization);
      if (uploadError) return uploadError;

      const thumbnailResult = await uploadThumbnailIfNeeded(uploadThumbnail, thumbnailUrl, thumbnailUploadUrl, headers.authorization);

      const finalizeResult = await finalizeVideoUpload(headers, videoUrn, uploadToken, uploadPartIds);
      if (!finalizeResult.success) {
        return new Response(JSON.stringify({ success: false, error: finalizeResult.error || 'Failed to finalize video upload' }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      let postResult = null;
      if (postData) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        postResult = await createLinkedInPost(headers, videoUrn, author, postData);
      }

      return new Response(JSON.stringify({
        success: true, videoUrn, fileSizeBytes, uploadToken, uploadPartIds,
        uploadResults, initializeResponse: initializeResponseJson, thumbnail: thumbnailResult, post: postResult
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
      'Access-Control-Max-Age': '86400'
    }
  });
}

async function parseAndValidateRequest(request) {
  try {
    const body = await request.json();
    if (!body.fileUrl) {
      return { error: new Response(JSON.stringify({ success: false, error: 'Missing fileUrl in request body' }), {
        status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })};
    }
    return { body: {
      fileUrl: body.fileUrl,
      author: body.author || 'urn:li:organization:2414183',
      thumbnailUrl: body.thumbnailUrl || null,
      mediaLibraryMetadata: body.mediaLibraryMetadata || null,
      uploadThumbnail: !!body.thumbnailUrl,
      accessToken: body.accessToken,
      linkedinVersion: body.linkedinVersion,
      restliProtocolVersion: body.restliProtocolVersion,
      postData: body.postData || null
    }};
  } catch {
    return { error: new Response(JSON.stringify({ success: false, error: 'Invalid JSON in request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })};
  }
}

function getRequestHeaders(request, body) {
  return {
    authorization: request.headers.get('Authorization') || (body.accessToken ? `Bearer ${body.accessToken}` : null),
    linkedinVersion: request.headers.get('LinkedIn-Version') || body.linkedinVersion || '202404',
    restliProtocolVersion: request.headers.get('X-RestLi-Protocol-Version') || body.restliProtocolVersion || '2.0.0'
  };
}

async function fetchVideoFile(fileUrl) {
  try {
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      return { error: new Response(JSON.stringify({ success: false, error: 'Failed to fetch file', status: fileResponse.status }), {
        status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })};
    }
    const videoBuffer = await fileResponse.arrayBuffer();
    return { videoBuffer, fileSizeBytes: videoBuffer.byteLength };
  } catch (error) {
    return { error: new Response(JSON.stringify({ success: false, error: `Error fetching video: ${error.message}` }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })};
  }
}

async function initializeVideoUpload(headers, author, fileSizeBytes, uploadThumbnail, mediaLibraryMetadata) {
  try {
    const payload = { initializeUploadRequest: { owner: author, fileSizeBytes, uploadThumbnail } };
    if (mediaLibraryMetadata) payload.initializeUploadRequest.mediaLibraryMetadata = mediaLibraryMetadata;

    const res = await fetch('https://api.linkedin.com/rest/videos?action=initializeUpload', {
      method: 'POST',
      headers: {
        'LinkedIn-Version': headers.linkedinVersion,
        'X-RestLi-Protocol-Version': headers.restliProtocolVersion,
        'Content-Type': 'application/json',
        'Authorization': headers.authorization
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { error: new Response(JSON.stringify({ success: false, error: 'Failed to initialize upload', responseBody: errorText }), {
        status: res.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })};
    }

    const json = await res.json();
    const videoUrn = json.value.video;
    const uploadInstructions = json.value.uploadInstructions;
    const uploadToken = json.value.uploadToken || '';
    const thumbnailUploadUrl = json.value.thumbnailUploadUrl || null;

    if (!Array.isArray(uploadInstructions) || uploadInstructions.length === 0) {
      return { error: new Response(JSON.stringify({ success: false, error: 'No upload instructions received from LinkedIn.' }), {
        status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })};
    }

    return { initializeResponseJson: json, videoUrn, uploadInstructions, uploadToken, thumbnailUploadUrl };
  } catch (error) {
    return { error: new Response(JSON.stringify({ success: false, error: `Error initializing upload: ${error.message}` }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })};
  }
}

async function uploadVideoChunks(uploadInstructions, videoBuffer, authorization) {
  try {
    const uploadPartIds = [];
    const uploadResults = [];

    for (let i = 0; i < uploadInstructions.length; i++) {
      const instruction = uploadInstructions[i];
      const chunkBuffer = videoBuffer.slice(instruction.firstByte, instruction.lastByte + 1);

      const uploadResponse = await fetch(instruction.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunkBuffer
      });

      if (!uploadResponse.ok) {
        return { error: new Response(JSON.stringify({ success: false, error: `Failed to upload chunk ${i + 1}/${uploadInstructions.length}` }), {
          status: uploadResponse.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        })};
      }

      const eTag = uploadResponse.headers.get('etag') || uploadResponse.headers.get('ETag');
      if (!eTag) {
        return { error: new Response(JSON.stringify({ success: false, error: 'Missing ETag in upload response', chunkNumber: i + 1 }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        })};
      }

      uploadPartIds.push(eTag);
      uploadResults.push({ chunkNumber: i + 1, byteRange: `${instruction.firstByte}-${instruction.lastByte}`, eTag });
    }

    return { uploadPartIds, uploadResults };
  } catch (error) {
    return { error: new Response(JSON.stringify({ success: false, error: `Error uploading chunks: ${error.message}` }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })};
  }
}

async function uploadThumbnailIfNeeded(uploadThumbnail, thumbnailUrl, thumbnailUploadUrl, authorization) {
  if (!uploadThumbnail || !thumbnailUrl || !thumbnailUploadUrl) return null;
  try {
    const thumbnailResponse = await fetch(thumbnailUrl);
    if (!thumbnailResponse.ok) throw new Error(`Failed to fetch thumbnail: ${thumbnailResponse.status}`);
    const thumbnailBuffer = await thumbnailResponse.arrayBuffer();

    const uploadResponse = await fetch(thumbnailUploadUrl, {
      method: 'PUT',
      headers: {
        'media-type-family': 'STILLIMAGE',
        'Content-Type': 'application/octet-stream',
        'X-LI-R2-W-MsgType': 'REST',
        'Accept': 'application/json',
        'Content-Length': String(thumbnailBuffer.byteLength),
        'Authorization': authorization
      },
      body: thumbnailBuffer
    });

    if (!uploadResponse.ok) throw new Error(`Thumbnail upload failed: ${uploadResponse.status}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function finalizeVideoUpload(headers, videoUrn, uploadToken, uploadPartIds) {
  try {
    const res = await fetch('https://api.linkedin.com/rest/videos?action=finalizeUpload', {
      method: 'POST',
      headers: {
        'LinkedIn-Version': headers.linkedinVersion,
        'X-RestLi-Protocol-Version': headers.restliProtocolVersion,
        'Content-Type': 'application/json',
        'Authorization': headers.authorization
      },
      body: JSON.stringify({ finalizeUploadRequest: { video: videoUrn, uploadToken, uploadedPartIds: uploadPartIds } })
    });
    if (!res.ok) {
      const errorText = await res.text();
      return { success: false, error: `Failed to finalize upload: ${res.status} - ${errorText}` };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function createLinkedInPost(headers, videoUrn, author, postData) {
  try {
    const postPayload = {
      author,
      content: { media: { id: videoUrn, title: postData.title || 'Video Upload' } },
      commentary: postData.commentary || '',
      visibility: postData.visibility || 'PUBLIC',
      distribution: { feedDistribution: postData.feedDistribution || 'MAIN_FEED' },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: postData.isReshareDisabledByAuthor === true
    };

    const postResponse = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        'LinkedIn-Version': headers.linkedinVersion,
        'X-RestLi-Protocol-Version': headers.restliProtocolVersion,
        'Content-Type': 'application/json',
        'Authorization': headers.authorization
      },
      body: JSON.stringify(postPayload)
    });

    if (!postResponse.ok) {
      const errorText = await postResponse.text();
      return { success: false, error: `Failed to create post: ${postResponse.status}`, details: errorText };
    }

    const locationHeader = postResponse.headers.get('Location');
    const postId = locationHeader ? locationHeader.split('/').pop() : null;
    return { success: true, status: postResponse.status, postId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
