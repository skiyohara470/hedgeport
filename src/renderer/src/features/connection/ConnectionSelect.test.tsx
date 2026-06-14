// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { ConnectionSelect } from './ConnectionSelect'
import type { ConnectionTarget } from './connectionTypes'

// このテストは起動時の接続先選択画面 ConnectionSelect の props 駆動契約を固定する。
// 計画 §4.3 / §6: targets を props 受け取り、選択時に onSelect を呼ぶ。
// 実接続・ハードコードのダミーは持たない（空配列なら空状態）。

afterEach(() => {
  cleanup()
})

const targets: ConnectionTarget[] = [
  {
    id: 'sftp-1',
    name: '社内SFTP',
    kind: 'sftp',
    host: 'sftp.example.com',
    port: 22,
    username: 'user',
    password: '',
    rootPath: '/',
  },
  {
    id: 's3-1',
    name: 'バックアップS3',
    kind: 's3',
    region: 'ap-northeast-1',
    accessKeyId: 'access-key',
    secretAccessKey: 'secret-key',
    sessionToken: '',
  },
]

describe('ConnectionSelect', () => {
  it('渡された接続先ごとに選択可能な項目を描画する', () => {
    // Given: 2件の接続先と onSelect
    const onSelect = vi.fn()

    // When: 描画
    render(<ConnectionSelect targets={targets} onSelect={onSelect} />)

    // Then: 各接続先名が選択可能な要素（button ロール）として並ぶ
    expect(screen.getByRole('button', { name: '社内SFTP' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'バックアップS3' })).toBeTruthy()
  })

  it('接続先をクリックすると対象を引数に onSelect を呼ぶ', () => {
    // Given: 描画済みの一覧
    const onSelect = vi.fn()
    render(<ConnectionSelect targets={targets} onSelect={onSelect} />)

    // When: 2件目をクリック
    fireEvent.click(screen.getByRole('button', { name: 'バックアップS3' }))

    // Then: クリックした target を引数に1回だけ呼ばれる
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(targets[1])
  })

  it('先頭の接続先をクリックすると先頭の target で onSelect を呼ぶ', () => {
    // Given: 描画済みの一覧（各項目が自分の target に束縛されることを担保）
    const onSelect = vi.fn()
    render(<ConnectionSelect targets={targets} onSelect={onSelect} />)

    // When: 1件目をクリック
    fireEvent.click(screen.getByRole('button', { name: '社内SFTP' }))

    // Then: クリックした先頭 target を引数に1回だけ呼ばれる
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(targets[0])
  })

  it('接続先が空のときは選択項目を描画しない（空状態）', () => {
    // Given: 空の接続先一覧
    const onSelect = vi.fn()

    // When: 描画
    render(<ConnectionSelect targets={[]} onSelect={onSelect} />)

    // Then: 選択可能な button は1つも無い
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('編集ボタンをクリックすると対象を引数に onEdit を呼ぶ', () => {
    const onSelect = vi.fn()
    const onEdit = vi.fn()
    render(<ConnectionSelect targets={targets} onSelect={onSelect} onEdit={onEdit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit 社内SFTP' }))

    expect(onEdit).toHaveBeenCalledWith(targets[0])
    expect(onSelect).not.toHaveBeenCalled()
  })
})
