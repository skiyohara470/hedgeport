interface ConnectionTargetBase {
  id: string
  name: string
}

export interface SftpConnectionTarget extends ConnectionTargetBase {
  kind: 'sftp'
  host: string
  port: number
  username: string
  password: string
  rootPath: string
}

export interface S3ConnectionTarget extends ConnectionTargetBase {
  kind: 's3'
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

export type ConnectionTarget = SftpConnectionTarget | S3ConnectionTarget

export interface ConnectionTestResult {
  ok: boolean
  message: string
}
