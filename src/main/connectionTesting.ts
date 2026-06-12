import { GetBucketLocationCommand, HeadBucketCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3'
import SftpClient from 'ssh2-sftp-client'

import type {
  ConnectionTarget,
  ConnectionTestResult,
  S3BucketListRequest,
} from '../shared/connections'
import { isConnectionTarget } from './connectionStore'

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeBucketRegion(location: string | undefined): string {
  if (!location) return 'us-east-1'
  if (location === 'EU') return 'eu-west-1'
  return location
}

export async function listS3Buckets(request: S3BucketListRequest): Promise<string[]> {
  if (
    !isString(request.region) ||
    !isString(request.accessKeyId) ||
    !isString(request.secretAccessKey) ||
    !isString(request.sessionToken)
  ) {
    throw new Error('Invalid S3 credentials.')
  }

  const client = new S3Client({
    region: request.region,
    credentials: {
      accessKeyId: request.accessKeyId,
      secretAccessKey: request.secretAccessKey,
      ...(request.sessionToken ? { sessionToken: request.sessionToken } : {}),
    },
    requestHandler: {
      requestTimeout: 10_000,
      connectionTimeout: 10_000,
    },
  })

  try {
    const output = await client.send(new ListBucketsCommand({}))
    const buckets = await Promise.all(
      (output.Buckets ?? []).flatMap(({ Name }) =>
        Name
          ? [
              // ListBuckets だけではリージョンが分からないので各 bucket を追跡する。
              client
                .send(new GetBucketLocationCommand({ Bucket: Name }))
                .then(({ LocationConstraint }) => ({
                  name: Name,
                  region: normalizeBucketRegion(LocationConstraint),
                })),
            ]
          : []
      )
    )
    return buckets
      .filter((bucket) => bucket.region === request.region)
      .map((bucket) => bucket.name)
      .sort((left, right) => left.localeCompare(right))
  } finally {
    client.destroy()
  }
}

export async function testConnection(target: ConnectionTarget): Promise<ConnectionTestResult> {
  if (!isConnectionTarget(target)) return { ok: false, message: 'Invalid connection settings.' }

  try {
    if (target.kind === 'sftp') {
      const client = new SftpClient('hedgeport-connection-test')
      try {
        await client.connect({
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password || undefined,
          readyTimeout: 10_000,
        })
        await client.list(target.rootPath)
      } finally {
        await client.end().catch(() => undefined)
      }
      return { ok: true, message: `Connected to ${target.host}:${target.port}.` }
    }

    const credentials = {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
      ...(target.sessionToken ? { sessionToken: target.sessionToken } : {}),
    }
    const client = new S3Client({
      region: target.region,
      credentials,
      requestHandler: {
        requestTimeout: 10_000,
        connectionTimeout: 10_000,
      },
    })
    try {
      await client.send(new HeadBucketCommand({ Bucket: target.bucket }))
    } finally {
      client.destroy()
    }
    return { ok: true, message: `Connected to s3://${target.bucket}.` }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}