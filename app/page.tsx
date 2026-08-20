export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#000",
        color: "#fff",
      }}
    >
      <div style={{ maxWidth: 640 }}>
        <h1 style={{ fontSize: 22, marginBottom: 12 }}>Live Player</h1>
        <p style={{ opacity: 0.8, lineHeight: 1.6, fontSize: 14 }}>
          Simple HLS live-stream proxy + player. No login, no database — fully stateless, driven
          entirely by the <code>?url=</code> query param.
        </p>
        <div style={{ marginTop: 20, fontSize: 13, lineHeight: 2 }}>
          <div>
            <strong>Watch:</strong> <code>/player?url=&lt;m3u8-url&gt;</code>
          </div>
          <div>
            <strong>Player API:</strong> <code>/api/pwlive/player?url=&lt;m3u8-url&gt;</code>
          </div>
          <div>
            <strong>Download-friendly playlist:</strong>{" "}
            <code>/api/pwlive/download?url=&lt;m3u8-url&gt;</code>
          </div>
        </div>
      </div>
    </main>
  );
}
