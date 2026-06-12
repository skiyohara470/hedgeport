export function PreviewWindow() {
  return (
    <main className="preview-window">
      <header>
        <div>
          <p className="eyebrow">File preview</p>
          <h1>No file selected</h1>
        </div>
        <span className="preview-badge">Future: diff view</span>
      </header>
      <section className="preview-canvas">
        <p>Select a file in a workspace to display its contents here.</p>
        <p>File reads and preview data are not connected in this phase.</p>
      </section>
    </main>
  )
}
