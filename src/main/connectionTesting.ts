import { S3Client } from '@aws-sdk/client-s3'
import SftpClient from 'ssh2-sftp-client'

import type { ConnectionTarget, ConnectionTestResult } from '../shared/connections'
import { isConnectionTarget } from './connectionStore'
import { listRegionBuckets } from './providers/S3Provider'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

    // S3 はアカウント単位。ListBuckets + region 解決でアクセス可否を確認し、
    // 設定 region 内の bucket 数を報告する（特定 bucket への HeadBucket は行わない）。
    const client = new S3Client({
      region: target.region,
      credentials: {
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
        ...(target.sessionToken ? { sessionToken: target.sessionToken } : {}),
      },
      requestHandler: {
        requestTimeout: 10_000,
        connectionTimeout: 10_000,
      },
    })
    try {
      const buckets = await listRegionBuckets(client, target.region)
      return {
        ok: true,
        message: `Connected to S3 (${target.region}): ${buckets.length} accessible bucket(s).`,
      }
    } finally {
      client.destroy()
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}
