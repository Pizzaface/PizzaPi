package sessions

// SessionsDirForTest exposes the internal sessionsDir helper to the external
// test package (sessions_test). It is only compiled during `go test`.
func (s *JSONLStore) SessionsDirForTest(cwd string) string {
	return s.sessionsDir(cwd)
}
