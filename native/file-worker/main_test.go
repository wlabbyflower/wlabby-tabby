package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func perform(t *testing.T, w *worker, r request) map[string]any {
	t.Helper()
	out, e := w.execute(r)
	if e != nil {
		t.Fatal(e)
	}
	return out
}
func TestAtomicUploadDownloadAndCleanup(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "空格 ' ; 文件.bin")
	data := bytes.Repeat([]byte{0, 1, 2, 255}, 20000)
	w := &worker{}
	defer w.cancel()
	perform(t, w, request{Action: "upload-start", Path: p, Size: int64(len(data))})
	for offset := 0; offset < len(data); offset += chunkSize {
		end := offset + chunkSize
		if end > len(data) {
			end = len(data)
		}
		perform(t, w, request{Action: "upload-chunk", Data: base64.StdEncoding.EncodeToString(data[offset:end])})
	}
	perform(t, w, request{Action: "upload-finish"})
	got, e := os.ReadFile(p)
	if e != nil || !bytes.Equal(got, data) {
		t.Fatal("upload corruption", e)
	}
	if _, e = w.execute(request{Action: "upload-start", Path: p, Size: 1}); e == nil {
		t.Fatal("silent overwrite")
	}
	perform(t, w, request{Action: "upload-start", Path: p, Size: 5, Overwrite: true})
	perform(t, w, request{Action: "upload-chunk", Data: base64.StdEncoding.EncodeToString([]byte("new"))})
	if _, e = w.execute(request{Action: "upload-finish"}); e == nil {
		t.Fatal("accepted truncated file")
	}
	w.cancel()
	got, _ = os.ReadFile(p)
	if !bytes.Equal(got, data) {
		t.Fatal("partial upload changed original")
	}
	items, _ := os.ReadDir(dir)
	if len(items) != 1 {
		t.Fatal("temporary upload leaked")
	}
	perform(t, w, request{Action: "download-start", Path: p})
	var received []byte
	for {
		out := perform(t, w, request{Action: "download-chunk"})
		part, e := base64.StdEncoding.DecodeString(out["data"].(string))
		if e != nil {
			t.Fatal(e)
		}
		received = append(received, part...)
		if out["eof"].(bool) {
			break
		}
	}
	if !bytes.Equal(data, received) {
		t.Fatal("download corruption")
	}
	perform(t, w, request{Action: "mkdir", Path: filepath.Join(dir, "directory")})
	list := perform(t, w, request{Action: "list", Path: dir})
	if len(list["entries"].([]entry)) != 2 {
		t.Fatal("directory listing")
	}
	dest := filepath.Join(dir, "renamed")
	perform(t, w, request{Action: "rename", Path: p, Destination: dest})
	perform(t, w, request{Action: "remove", Path: dest})
}
func TestProtocolErrorsAndEOFRemovePartialUpload(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cancelled")
	requests := []request{{ID: 1, Action: "upload-start", Path: p, Size: 5}, {ID: 2, Action: "upload-chunk", Data: base64.StdEncoding.EncodeToString([]byte("abc"))}}
	var input, output bytes.Buffer
	for _, r := range requests {
		json.NewEncoder(&input).Encode(r)
	}
	if e := serve(&input, &output); e != nil {
		t.Fatal(e)
	}
	items, _ := os.ReadDir(filepath.Dir(p))
	if len(items) != 0 {
		t.Fatal("EOF leaked temporary upload")
	}
	w := &worker{}
	for _, r := range []request{{Action: "list", Path: "relative"}, {Action: "remove", Path: "/"}, {Action: "download-start", Path: filepath.Dir(p)}, {Action: "upload-start", Path: p, Size: maxFile + 1}} {
		if _, e := w.execute(r); e == nil {
			t.Fatalf("accepted invalid request: %+v", r)
		}
	}
}
