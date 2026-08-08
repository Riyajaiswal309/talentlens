import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

/**
 * Object storage for resume files (PRD §16 Table 16.1, §20 stage 1).
 *
 * The same S3 API is used in development and production. Locally it resolves
 * to LocalStack via S3_ENDPOINT; in production S3_ENDPOINT is unset, the SDK
 * resolves the real regional endpoint, and credentials come from the pod's
 * IAM role. Keeping one code path is the reason LocalStack was chosen over a
 * filesystem adapter — an untested S3 implementation is a production defect
 * waiting for deployment day.
 *
 * This service deliberately never creates a bucket. The production bucket is
 * Terraform-managed and KMS-encrypted (PRD §24.2, §29); an application that
 * can create buckets needs IAM rights it should not hold.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    this.bucket = this.config.get<string>('S3_BUCKET') ?? 'talentlens-resumes-dev';

    this.client = new S3Client({
      region: this.config.get<string>('S3_REGION') ?? 'us-east-1',
      ...(endpoint
        ? {
            endpoint,
            // LocalStack serves buckets as a path segment rather than a
            // subdomain, because *.localhost does not resolve.
            forcePathStyle: true,
            credentials: {
              accessKeyId: this.config.get<string>('AWS_ACCESS_KEY_ID') ?? 'test',
              secretAccessKey: this.config.get<string>('AWS_SECRET_ACCESS_KEY') ?? 'test',
            },
          }
        : {}),
    });

    this.logger.log(`resume storage: bucket=${this.bucket} endpoint=${endpoint ?? 'aws'}`);
  }

  /**
   * Build the object key for a resume.
   *
   * Tenant-prefixed so a future bucket policy or lifecycle rule can be scoped
   * per company, and random so the key discloses nothing about the applicant
   * — the file name they chose is not part of the path.
   *
   * The key is generated BEFORE the database rows exist, because PRD §20
   * orders persistence to S3 ahead of row creation. It therefore cannot embed
   * an application or candidate id.
   */
  buildResumeKey(companyId: string, extension: string, now: Date = new Date()): string {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `resumes/${companyId}/${year}/${month}/${randomUUID()}.${extension}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Production encrypts with a customer-managed KMS key; LocalStack does
        // not emulate KMS, so this is applied only against real S3.
        ...(this.config.get<string>('S3_ENDPOINT') ? {} : { ServerSideEncryption: 'aws:kms' }),
      }),
    );
  }

  /**
   * Compensating delete.
   *
   * Used when the file was stored but the database transaction that would
   * have referenced it failed. Without this, a rolled-back submission leaves
   * an orphaned object that nothing points at and no retention rule covers.
   *
   * Deliberately swallows its own failure: it runs while another error is
   * already propagating, and an orphaned object is a far smaller problem than
   * masking the real cause of the request failure.
   */
  async deleteQuietly(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      this.logger.error(
        `orphaned resume object could not be removed: ${key}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
