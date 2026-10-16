package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	sdk "gitee.com/linakesi/lzc-sdk/lang/go"
	"gitee.com/linakesi/lzc-sdk/lang/go/localdevice"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type permissions struct {
	localdevice.UnimplementedPermissionManagerServer
	app    []byte
	public ed25519.PublicKey
	denied bool
	calls  int
}

func (s *permissions) RequestAuthToken(_ context.Context, r *localdevice.RequestAuthTokenRequest) (*localdevice.RequestAuthTokenResponse, error) {
	s.calls++
	if s.denied {
		return nil, status.Error(codes.PermissionDenied, "synthetic permission denied")
	}
	if !bytes.Equal(r.AppCert, s.app) || !ed25519.Verify(s.public, []byte("synthetic-app-id"), r.Signature) {
		return nil, status.Error(codes.Unauthenticated, "invalid app proof")
	}
	return &localdevice.RequestAuthTokenResponse{Token: "synthetic-device-token", Deadline: timestamppb.New(time.Now().Add(time.Minute))}, nil
}
func TestSDKCertificateAuthorization(t *testing.T) {
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-ca"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour)}
	der, e := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, public, private)
	if e != nil {
		t.Fatal(e)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	ca, e := x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	appPublic, appPrivate, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	app := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "test-app", SerialNumber: "synthetic-app-id"}, NotBefore: caTemplate.NotBefore, NotAfter: caTemplate.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
	appDER, e := x509.CreateCertificate(rand.Reader, app, ca, appPublic, private)
	if e != nil {
		t.Fatal(e)
	}
	appPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: appDER})
	keyDER, e := x509.MarshalPKCS8PrivateKey(appPrivate)
	if e != nil {
		t.Fatal(e)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	dir := t.TempDir()
	oldCA, oldApp, oldKey := sdk.CAPath, sdk.APPCertPath, sdk.APPKeyPath
	t.Cleanup(func() { sdk.CAPath, sdk.APPCertPath, sdk.APPKeyPath = oldCA, oldApp, oldKey })
	sdk.CAPath = filepath.Join(dir, "ca.crt")
	sdk.APPCertPath = filepath.Join(dir, "app.crt")
	sdk.APPKeyPath = filepath.Join(dir, "app.key")
	for path, data := range map[string][]byte{sdk.CAPath: caPEM, sdk.APPCertPath: appPEM, sdk.APPKeyPath: keyPEM} {
		if e := os.WriteFile(path, data, 0600); e != nil {
			t.Fatal(e)
		}
	}
	cert, e := tls.X509KeyPair(appPEM, keyPEM)
	if e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(caPEM)
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	service := &permissions{app: appPEM, public: appPublic}
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots})))
	localdevice.RegisterPermissionManagerServer(server, service)
	go server.Serve(listener)
	defer server.Stop()
	gatewayListener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	gateway := grpc.NewServer()
	go gateway.Serve(gatewayListener)
	defer gateway.Stop()
	t.Setenv("LZCAPP_API_GATEWAY_ADDRESS", gatewayListener.Addr().String())
	oldArgs, oldStdout := os.Args, os.Stdout
	defer func() { os.Args, os.Stdout = oldArgs, oldStdout }()
	os.Args = []string{"client-auth-token", "https://" + listener.Addr().String()}
	reader, writer, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	os.Stdout = writer
	e = run()
	writer.Close()
	os.Stdout = oldStdout
	data, _ := io.ReadAll(reader)
	reader.Close()
	if e != nil {
		t.Fatal(e)
	}
	var result map[string]string
	if e := json.Unmarshal(data, &result); e != nil {
		t.Fatal(e)
	}
	if result["token"] != "synthetic-device-token" || len(result) != 1 || service.calls != 1 {
		t.Fatal("unexpected SDK result")
	}
	service.denied = true
	reader, writer, _ = os.Pipe()
	os.Stdout = writer
	e = run()
	writer.Close()
	os.Stdout = oldStdout
	data, _ = io.ReadAll(reader)
	reader.Close()
	if e == nil || len(data) != 0 {
		t.Fatal("denied device must not return a token")
	}
}
