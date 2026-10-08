import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { listInbox, markInboxItemRead, resolveInboxItem, type InboxItem } from "@remotecode/client";

type Props = { origin: string };

export function InboxScreen({ origin }: Props) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const data = await listInbox(origin);
      setItems(data);
      setLoading(false);
    } catch {
      setError("Could not load Inbox.");
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [origin]);

  async function handleMarkRead(item: InboxItem) {
    try {
      await markInboxItemRead(item.id, origin);
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
    } catch {
      setError("Could not mark item read.");
    }
  }

  async function handleResolve(item: InboxItem) {
    try {
      await resolveInboxItem(item.id, origin);
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, state: "resolved" } : i)));
    } catch {
      setError("Could not resolve item.");
    }
  }

  if (loading) return <Text style={styles.status}>Loading Inbox…</Text>;
  if (error) return <Text style={styles.error}>{error}</Text>;

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {items.length === 0 ? <Text style={styles.status}>No Inbox items.</Text> : null}
      {items.map((item) => (
        <View key={item.id} style={[styles.row, item.read && styles.readRow]}>
          <Text style={styles.name}>{item.title}</Text>
          <Text style={styles.skills}>State: {item.state} · Kind: {item.kind}</Text>
          <View style={styles.actions}>
            {!item.read ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Mark ${item.title} read`} onPress={() => void handleMarkRead(item)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>Mark read</Text>
              </Pressable>
            ) : null}
            {item.state !== "resolved" ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Resolve ${item.title}`} onPress={() => void handleResolve(item)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>Resolve</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, gap: 12, padding: 16 },
  row: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 12, borderWidth: 1, padding: 14, gap: 6 },
  readRow: { opacity: 0.6 },
  name: { color: "#183337", fontSize: 15, fontWeight: "600" },
  skills: { color: "#50696b", fontSize: 13 },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
  smallButton: { backgroundColor: "#126b54", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  smallButtonText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  status: { color: "#50696b", fontSize: 14 },
  error: { color: "#9c3026", fontSize: 14 },
});