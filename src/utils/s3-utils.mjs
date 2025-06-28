import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

export class S3Utils {
    constructor({ region }) {
        this.s3 = new S3Client({ region });
    }

    async uploadText({ bucket, key, body, contentType = "text/plain" }) {
        await this.s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType
        }));
    }

    async uploadBuffer({ bucket, key, buffer, contentType = "application/octet-stream" }) {
        await this.s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType
        }));
    }

    async getObject({ bucket, key }) {
        return this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    }

    async deleteObject({ bucket, key }) {
        return this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }

    generatePublicUrl({ cfUrl, key }) {
        // Assumes CloudFront is set up to serve the S3 bucket
        return `${cfUrl}/${key}`;
    }
}
