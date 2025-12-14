// Cloudflare worker
var decompress = require('brotli/decompress');

const releases_url = "https://api.github.com/repos/PunishXIV/WrathCombo/releases?per_page=1&page=1";

import debug_reader_html from './html/debug-reader.html' assert { type: 'text' };

async function getLatestDraftRelease(env) {
	// Get valid Keys from AutoRepo's Variables
	let releases_request = new Request(releases_url, {
		method: 'GET',
		headers: {
			'User-Agent': 'WrathComboLink-Worker',
			'Accept': 'application/vnd.github+json',
			'Authorization': 'Bearer ' + env.DraftReleaseKey,
			'X-GitHub-Api-Version': '2022-11-28',
		},
		cache: 'no-store',
	});
	let releases_response = await fetch(releases_request);
	if (releases_response.status !== 200) {
		return "{'error': 'Broken GitHub PAT', 'errorDetails': '" + await releases_response.text() + "'}";
	}

	// Parse the Keys from the Repository Variables
	let releases_json = await releases_response.json();

	// Error for no releases
	if (releases_json.length === 0) {
		return "{'error': 'No GitHub Releases'}";
	}

	let release_json = releases_json[0];

	// Error for latest not being a draft
	if (release_json["draft"] !== true) {
		return "{'error': 'Latest GitHub Release is not a draft, one needs made'}";
	}

	return release_json["html_url"];
}

async function handleDebugReader(request) {
	if (request.method === "GET") {
		return new Response(debug_reader_html, {
			headers: { "Content-Type": "text/html" }
		});
	}

	if (request.method === "POST") {
		const debugLog = [];
		const log = (step, details) => debugLog.push({ step, details });

		try {
			const formData = await request.formData();
			let content = "";

			const file = formData.get("fileInput");
			if (file && file instanceof File && file.size > 0) {
				content = await file.text();
				log("Input", `File: ${file.name} (${file.size} bytes)`);
			} else {
				content = formData.get("textInput") || "";
				log("Input", `Text input (${content.length} chars)`);
			}

			if (!content) {
				throw new Error("No content provided");
			}

			// Extract content between markers
			const startMarker = "START DEBUG CODE";
			const endMarker = "END DEBUG CODE";
			let startIdx = content.indexOf(startMarker);

			if (startIdx !== -1) {
				startIdx += startMarker.length;
				let endIdx = content.indexOf(endMarker, startIdx);
				content = endIdx !== -1
					? content.substring(startIdx, endIdx)
					: content.substring(startIdx);
				log("Extraction", `Found markers. Extracted length: ${content.length}`);
			} else {
				log("Extraction", "No markers found. Using full content.");
			}

			// Remove any whitespace or non-base64 characters
			content = content.replace(/[^A-Za-z0-9+/=]/g, '');
			log("Sanitization", `Cleaned Base64 length: ${content.length}`);

			// Base64 Decode
			const binaryString = atob(content);
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) {
				bytes[i] = binaryString.charCodeAt(i);
			}
			log("Base64 Decode", `Byte array length: ${bytes.length}`);

			let jsonString;
			try {
				// Attempt Brotli-in-browser decompression
				log("Decompression", "Attempting Native Brotli...");
				const ds = new DecompressionStream('brotli');
				const writer = ds.writable.getWriter();
				writer.write(bytes);
				writer.close();
				const decompressed = await new Response(ds.readable).arrayBuffer();
				jsonString = new TextDecoder().decode(decompressed);
				log("Decompression", `Native Brotli success. Result string length: ${jsonString.length}`);
			} catch (e) {
				try {
					// Fallback: Try to use 'brotli' library
					log("Decompression", "Attempting fallback with" +
						" packaged brotli...");

					if (!decompress) throw new Error("Could not load decompress function from 'brotli'");

					const decompressed = decompress(bytes);
					jsonString = new TextDecoder().decode(decompressed);
					log("Decompression", `Fallback library success. Result string length: ${jsonString.length}`);
				} catch (e2) {
					log("Decompression", `Fallback library failed: ${e2.message}`);

					// Fallback to raw string (legacy format or decompression failed)
					// Note: If decompression failed but the data WAS compressed, this will produce garbage
					jsonString = new TextDecoder().decode(bytes);
					log("Fallback", `Decoded raw bytes to string. String length: ${jsonString.length}`);
				}
			}

			// Preview the string before parsing
			// We escape it to see hidden characters like \u001b
			const preview = jsonString.substring(0, 100).replace(/[\u0000-\u001F\u007F-\u009F]/g, c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
			log("String Preview", preview + "...");

			// Parse JSON
			log("JSON Parse", "Attempting to parse...");
			const json = JSON.parse(jsonString);
			log("JSON Parse", "Success");

			// Return the debug log AND the data
			return new Response(JSON.stringify(json, null, 8), {
				headers: { "Content-Type": "application/json" }
			});

		} catch (e) {
			return new Response(JSON.stringify({
				error: "Failed to process debug code",
				details: e.message,
				debugLog: debugLog
			}, null, 2), {
				status: 400,
				headers: { "Content-Type": "application/json" }
			});
		}
	}

	return new Response(null, { status: 400, statusText: 'Debug Reading Failed' });
}

async function handleRequest(request, env) {
	// redirect /patchnotes-draft to Wrath Combo's most recent draft release
	if (request.url.indexOf("/patchnotes-draft") !== -1) {

		let draftURL = await getLatestDraftRelease(env);

		// Check if draftURL contains an error (JSON object)
		if (draftURL.includes('{')) {
			return new Response(draftURL, {
				status: 400,
				headers: { "Content-Type": "application/json" }
			});
		}

		return Response.redirect(
			draftURL,
			302
		);
	}

	// Debug Reader Route
	if (request.url.indexOf("/debug-reader") !== -1) {
		return handleDebugReader(request);
	}

	return new Response(null, { status: 404, statusText: 'Endpoint Not Found' });
}

export default {
	async fetch(request, env) {
		if (request.method === 'GET' || request.method === 'POST') {
			// Handle requests to the API server
			return handleRequest(request, env);
		} else {
			return new Response(null, {
				status: 405,
				statusText: 'Method Not Allowed',
			});
		}
	}
}