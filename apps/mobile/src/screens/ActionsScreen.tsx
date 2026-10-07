import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ActionEventState } from "@remotecode/client";
import { emptyActionEventState } from "@remotecode/client";

type Props = { events: ActionEventState };

export function ActionsScreen({ events }: Props) {
  if (events.actions.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={styles.status}>No actions yet.</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {events.actions.map((receipt) => (
        <View key={receipt.id} style={styles.row}>
          <Text style={styles.name}>{receipt.action}</Text>
          <Text style={styles.skills}>Receipt {receipt.id}</Text>
          <Text style={styles.skills}>{String(receipt.createdAt)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, gap: 12, padding: 16 },
  row: { backgroundColor: "#fff", borderColor: "#d9e5e0", borderRadius: 12, borderWidth: 1, padding: 14, gap: 4 },
  name: { color: "#183337", fontSize: 15, fontWeight: "600" },
  skills: { color: "#50696b", fontSize: 13 },
  status: { color: "#50696b", fontSize: 14 },
});