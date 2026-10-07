import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { listBots, listSchedules, type Bot, type Schedule } from "@remotecode/client";

type Props = { origin: string };

export function BotsScreen({ origin }: Props) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [routines, setRoutines] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const data = await listBots(origin);
        if (active) { setBots(data); setLoading(false); }
      } catch {
        if (active) { setError("Could not load Bots."); setLoading(false); }
      }
    }
    void load();
    return () => { active = false; };
  }, [origin]);

  async function loadRoutines(bot: Bot) {
    setSelectedBot(bot);
    setRoutinesLoading(true);
    try {
      const data = await listSchedules(origin);
      setRoutines(data.filter((s) => s.botId === bot.id));
    } catch {
      setError("Could not load routines.");
    } finally {
      setRoutinesLoading(false);
    }
  }

  if (loading) return <Text style={styles.status}>Loading Bots…</Text>;
  if (error && !selectedBot) return <Text style={styles.error}>{error}</Text>;

  if (selectedBot) {
    return (
      <ScrollView contentContainerStyle={styles.list}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to Bots" onPress={() => { setSelectedBot(null); setRoutines([]); }} style={styles.backButton}>
          <Text style={styles.backText}>Back to Bots</Text>
        </Pressable>
        <Text style={styles.heading}>Routines for {selectedBot.name}</Text>
        {routinesLoading ? <Text style={styles.status}>Loading routines…</Text> : null}
        {error && selectedBot ? <Text style={styles.error}>{error}</Text> : null}
        {routines.length === 0 ? <Text style={styles.status}>No routines for this Bot.</Text> : null}
        {routines.map((s) => (
          <View key={s.id} style={styles.row}>
            <Text style={styles.name}>{s.kind}: {s.prompt}</Text>
            <Text style={styles.skills}>
              {s.localTime} ({s.timezone}) {s.enabled ? "enabled" : "paused"}
              {s.nextOccurrence ? ` · next: ${s.nextOccurrence.plannedAt}` : ""}
            </Text>
          </View>
        ))}
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {bots.length === 0 ? <Text style={styles.status}>No Bots yet.</Text> : null}
      {bots.map((bot) => (
        <Pressable
          key={bot.id}
          accessibilityRole="button"
          accessibilityLabel={`Bot ${bot.name}`}
          onPress={() => void loadRoutines(bot)}
          style={styles.row}
        >
          <Text style={styles.name}>{bot.name}</Text>
          <Text style={styles.skills}>
            {bot.skills.length > 0 ? bot.skills.join(", ") : "No skills"}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, gap: 12, padding: 16 },
  row: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 12, borderWidth: 1, padding: 14, gap: 4 },
  name: { color: "#183337", fontSize: 15, fontWeight: "600" },
  skills: { color: "#50696b", fontSize: 13 },
  heading: { color: "#183337", fontSize: 16, fontWeight: "700", marginBottom: 8 },
  status: { color: "#50696b", fontSize: 14 },
  error: { color: "#9c3026", fontSize: 14 },
  backButton: { alignItems: "center", backgroundColor: "#126b54", borderRadius: 10, justifyContent: "center", minHeight: 42, paddingHorizontal: 16, marginTop: 12 },
  backText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});