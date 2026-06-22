import { S3Client } from '@aws-sdk/client-s3'
import SftpClient from 'ssh2-sftp-client'

import type { ConnectionDraft, ConnectionTestResult } from '../shared/connections'
import { extractSecrets, getStoredSecrets, isValidS3Secrets, isValidSftpSecrets } from './connectionSecrets'
import { isConnectionTarget } from './connectionStore'
import { listRegionBuckets } from './providers/S3Provider'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 接続の疎通確認を行う。
 * secret は下書きに含まれていればそれを使い、含まれていなければ保存済み secret を復号して使う
 * （既存接続を再入力なしでテストできるようにするため）。secret は main 内でのみ扱う。
 *
 * draft.kind と secret の shape が一致しない場合（kind mismatch）は明確に失敗結果を返す。
 * これは resolveConnection / createStorageProvider と同じ境界検証。
 *
 * @param draft 接続先の下書き（secret は任意）
 * @returns 疎通可否とメッセージ
 */
export async function testConnection(draft: ConnectionDraft): Promise<ConnectionTestResult> {
  if (!isConnectionTarget(draft)) return { ok: false, message: 'Invalid connection settings.' }

  // 下書きの secret を優先し、無ければ保存済み secret を使う。復号失敗（safeStorage 不可等）は失敗結果にする。
  let rawSecrets: ReturnType<typeof extractSecrets>['secrets'] | ReturnType<typeof getStoredSecrets>
  try {
    rawSecrets = extractSecrets(draft).secrets ?? getStoredSecrets(draft.id)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }

  try {
    if (draft.kind === 'sftp') {
      // non-null の secret が SFTP shape でなければ kind mismatch として明確に失敗させる。
      if (rawSecrets !== null && !isValidSftpSecrets(rawSecrets)) {
        return {
          ok: false,
          message:
            'Stored credential for this SFTP connection has an unexpected format. Please re-enter and save the credentials.',
        }
      }
      // null（未保存 / 空 password）は鍵認証等で許容する。
      const password = isValidSftpSecrets(rawSecrets) ? rawSecrets.password : ''
      const client = new SftpClient('hedgeport-connection-test')
      try {
        await client.connect({
          host: draft.host,
          port: draft.port,
          username: draft.username,
          password: password || undefined,
          readyTimeout: 10_000,
        })
        await client.list(draft.rootPath)
      } finally {
        await client.end().catch(() => undefined)
      }
      return { ok: true, message: `Connected to ${draft.host}:${draft.port}.` }
    }

    // S3: secret がない、または S3 shape でなければ明確な失敗。
    if (!rawSecrets) return { ok: false, message: 'Credentials are required to test this S3 connection.' }
    if (!isValidS3Secrets(rawSecrets)) {
      return {
        ok: false,
        message:
          'Stored credential for this S3 connection has an unexpected format. Please re-enter and save the credentials.',
      }
    }
    const { accessKeyId, secretAccessKey, sessionToken } = rawSecrets

    // S3 はアカウント単位。ListBuckets + region 解決でアクセス可否を確認し、
    // 設定 region 内の bucket 数を報告する（特定 bucket への HeadBucket は行わない）。
    const client = new S3Client({
      region: draft.region,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      },
      requestHandler: {
        requestTimeout: 10_000,
        connectionTimeout: 10_000,
      },
    })
    try {
      const buckets = await listRegionBuckets(client, draft.region)
      return {
        ok: true,
        message: `Connected to S3 (${draft.region}): ${buckets.length} accessible bucket(s).`,
      }
    } finally {
      client.destroy()
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}
