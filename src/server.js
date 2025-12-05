// server.js (ESM)
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import AdmZip from "adm-zip";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// ------------------------------------------------------------------
// Định nghĩa __dirname và __filename cho ES Modules (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ------------------------------------------------------------------

// --- Config dotenv ---
const envPath = path.join(__dirname, "../.env");
console.log(`💡 Đang cố gắng load file ENV tại: ${envPath}`);
dotenv.config({ path: envPath });

const app = express();
app.use(express.json());

// Multer
const upload = multer({ dest: path.join(__dirname, "uploads/") });

// NETLIFY_TOKEN từ env
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

console.log(
    "NETLIFY_TOKEN:",
    NETLIFY_TOKEN ? `${NETLIFY_TOKEN.substring(0, 10)}...` : "KHÔNG CÓ"
);

if (!NETLIFY_TOKEN) {
    console.error("Vui lòng set NETLIFY_TOKEN trước khi chạy");
}

// --- Hàm tạo site + deploy + publish ---
async function deployToNetlify(zipPath, siteName) {
    if (!NETLIFY_TOKEN) throw new Error("NETLIFY_TOKEN chưa cấu hình.");

    console.log("\n=== BẮT ĐẦU DEPLOY ===");
    console.log("Site name:", siteName);
    console.log("Zip path:", zipPath); // 1) Tạo site mới

    console.log("\n[1/3] Đang tạo site trên Netlify...");
    let createRes;
    try {
        createRes = await fetch("https://api.netlify.com/api/v1/sites", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${NETLIFY_TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: siteName }),
        });
    } catch (networkErr) {
        console.error("Network error:", networkErr);
        throw new Error(`Không thể kết nối Netlify: ${networkErr.message}`);
    }

    console.log("Response status:", createRes.status, createRes.statusText);

    let responseText;
    try {
        responseText = await createRes.text();
        console.log("Response body length:", responseText.length);
    } catch (readErr) {
        console.error("Lỗi đọc response:", readErr);
        throw new Error(`Không đọc được response: ${readErr.message}`);
    } // Parse JSON

    let siteJson;
    try {
        siteJson = JSON.parse(responseText);
        console.log("Parse JSON thành công");
        console.log("Site ID:", siteJson.id);
    } catch (parseErr) {
        console.error("Lỗi parse JSON:", parseErr);
        console.error("Response text:", responseText.substring(0, 500));
        throw new Error(
            `Response không phải JSON: ${responseText.substring(0, 200)}`
        );
    } // Kiểm tra status

    if (!createRes.ok) {
        console.error("API trả về lỗi:", siteJson);
        throw new Error(
            `Netlify API lỗi ${createRes.status}: ${JSON.stringify(siteJson)}`
        );
    } // Kiểm tra site ID

    if (!siteJson.id) {
        console.error("Response không có site ID:", siteJson);
        throw new Error("Response thiếu site ID");
    }

    const siteId = siteJson.id;
    console.log("Site đã tạo:", siteId);

    console.log("\n[2/3] Đang upload ZIP...");

    let deployRes;
    try {
        deployRes = await fetch(
            `https://api.netlify.com/api/v1/sites/${siteId}/deploys`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${NETLIFY_TOKEN}`,
                    "Content-Type": "application/zip",
                },
                body: fs.createReadStream(zipPath),
            }
        );
    } catch (uploadErr) {
        console.error("Upload error:", uploadErr);
        throw new Error(`Upload thất bại: ${uploadErr.message}`);
    }

    console.log("Deploy response status:", deployRes.status);

    const deployText = await deployRes.text();
    let deployJson;
    try {
        deployJson = JSON.parse(deployText);
    } catch (e) {
        console.error(
            "Deploy response không phải JSON:",
            deployText.substring(0, 500)
        );
        throw new Error("Deploy response invalid");
    }

    if (!deployRes.ok) {
        console.error("Deploy thất bại:", deployJson);
        const err = new Error("Deploy thất bại");
        // Gán thuộc tính custom trong JS
        err.detail = deployJson;
        throw err;
    }

    console.log("Deploy ID:", deployJson.id);

    console.log("\n[3/3] Deploy đã hoàn tất");

    return {
        site: siteJson,
        deploy: deployJson,
        liveUrl: deployJson.ssl_url || siteJson.ssl_url,
    };
}

// --- Route deploy ---
app.post("/api/deploy", upload.single("file"), async (req, res) => {
    try {
        if (!NETLIFY_TOKEN)
            return res
                .status(500)
                .json({ message: "Server chưa cấu hình NETLIFY_TOKEN" });

        const uploaded = req.file;
        if (!uploaded)
            return res
                .status(400)
                .json({ message: "Chưa gửi file data.zip (field 'file')" });

        const dataZipPath = path.resolve(uploaded.path);
        const distZipPath = path.resolve(__dirname, "../dist.zip");

        if (!fs.existsSync(distZipPath)) {
            try {
                fs.unlinkSync(dataZipPath);
            } catch (e) {}
            return res.status(400).json({
                message:
                    "File dist.zip không tồn tại trên server (đặt dist.zip ở backend/)",
            });
        }

        const dataZip = new AdmZip(dataZipPath);
        const distZip = new AdmZip(distZipPath);
        const mergedZip = new AdmZip();

        // Thêm nội dung từ dist.zip (Code tĩnh)
        distZip.getEntries().forEach((entry) => {
            if (!entry.isDirectory) {
                mergedZip.addFile(entry.entryName, entry.getData());
            }
        });

        // Thêm file _redirects
        const redirectsContent = "/* /index.html 200";
        mergedZip.addFile("_redirects", Buffer.from(redirectsContent, "utf8"));
        console.log("-> Đã thêm _redirects vào ZIP.");

        // Thêm toàn bộ nội dung từ data.zip và giữ nguyên cấu trúc thư mục data/
        dataZip.getEntries().forEach((entry) => {
            try {
                // Thêm tất cả entries, bao gồm cả thư mục data/, data/data.json và data/config.json
                if (!entry.isDirectory) {
                    mergedZip.addFile(entry.entryName, entry.getData());
                } else if (entry.entryName.endsWith("/")) {
                    // Nếu là thư mục, AdmZip tự tạo thư mục này nếu cần
                    mergedZip.addFile(entry.entryName, Buffer.alloc(0));
                }
                console.log(`-> Merge data entry: ${entry.entryName}`);
            } catch (e) {
                console.warn(
                    "Không thể thêm entry từ data.zip:",
                    entry.entryName,
                    e
                );
            }
        });

        // Ghi zip tạm
        const tempZipPath = path.join(
            __dirname,
            `dist_with_data_${Date.now()}.zip`
        );
        mergedZip.writeZip(tempZipPath);
        console.log("-> File ZIP đã merge được tạo thành công:", tempZipPath);

        // Deploy
        const siteName = `alphawave-quiz-${Date.now()}`;
        const result = await deployToNetlify(tempZipPath, siteName);

        // Xóa file tạm
        [tempZipPath, dataZipPath].forEach((file) => {
            try {
                fs.unlinkSync(file);
            } catch (e) {}
        });

        return res.json({
            message: "Deploy thành công",
            url: result.liveUrl,
        });
    } catch (err) {
        console.error("Lỗi /api/deploy:", err);

        let errorMessage = "Deploy thất bại không rõ nguyên nhân";
        let errorDetail = null;

        if (typeof err === "object" && err !== null) {
            if ("message" in err && typeof err.message === "string") {
                errorMessage = err.message;
            }
            if ("detail" in err) {
                errorDetail = err.detail;
            }
        }

        return res.status(500).json({
            message: "Deploy thất bại",
            error: errorMessage,
            detail: errorDetail,
        });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server chạy trên cổng ${PORT}`));
