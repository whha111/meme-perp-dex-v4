import { NextRequest, NextResponse } from "next/server";

/**
 * P0-1: Server-side IPFS upload proxy
 * Pinata JWT stays on the server — never exposed to client bundle
 */
const PINATA_JWT = process.env.PINATA_JWT; // NOT NEXT_PUBLIC_ — server-only

export async function POST(req: NextRequest) {
  if (!PINATA_JWT) {
    return NextResponse.json({ error: "IPFS upload not configured" }, { status: 503 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Validate file type
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
    }

    // Validate file size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (max 5MB)" }, { status: 400 });
    }

    // Forward to Pinata
    const pinataForm = new FormData();
    pinataForm.append("file", file);
    pinataForm.append("pinataMetadata", JSON.stringify({
      name: `token-logo-${Date.now()}`,
      keyvalues: { type: "token-logo", uploadedAt: new Date().toISOString() },
    }));
    pinataForm.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

    const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${PINATA_JWT}` },
      body: pinataForm,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return NextResponse.json({ error: err.message || "Upload failed" }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json({ ipfsHash: data.IpfsHash });
  } catch (error) {
    console.error("[API/upload] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
