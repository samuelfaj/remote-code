import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { getMobileHealth } from "./src/features/health/api";

type HealthStatus = "checking" | "ready" | "not_ready" | "unavailable";
const apiOrigin = process.env.EXPO_PUBLIC_API_ORIGIN ?? "http://127.0.0.1:3000";

export default function App() {
  const [status, setStatus] = useState<HealthStatus>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus("checking");
    void getMobileHealth(apiOrigin).then((health) => {
      if (active) setStatus(health === "ready" ? "ready" : "not_ready");
    }).catch(() => {
      if (active) setStatus("unavailable");
    });
    return () => { active = false; };
  }, [attempt]);

  const label = {
    checking: "Checking API health",
    ready: "API ready",
    not_ready: "API not ready",
    unavailable: "API health unavailable",
  }[status];

  return (
    <View style={styles.page}>
      <Text accessibilityRole="header" style={styles.title}>RemoteCode mobile</Text>
      <Text style={styles.endpoint}>Host: {apiOrigin}</Text>
      <View style={styles.card}>
        {status === "checking" ? <ActivityIndicator accessibilityLabel="Checking API health" /> : null}
        <Text accessibilityRole="text" accessibilityLiveRegion="polite" testID="host-health-status" style={styles.status}>{label}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh host health" onPress={() => setAttempt((value) => value + 1)} style={styles.button}>
          <Text style={styles.buttonText}>Refresh host health</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#f4f7f5" },
  title: { color: "#183337", fontSize: 28, fontWeight: "700", marginBottom: 12 },
  endpoint: { color: "#50696b", fontSize: 14, marginBottom: 20 },
  card: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 16, borderWidth: 1, gap: 16, padding: 20 },
  status: { color: "#183337", fontSize: 18, fontWeight: "600" },
  button: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 10, justifyContent: "center", minHeight: 46, paddingHorizontal: 16 },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
