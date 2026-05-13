import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface Tier {
  id: string;
  name: string;
  price: string;
  period: string;
  features: string[];
  highlight: boolean;
}

const TIERS: Tier[] = [
  {
    id: 'free',
    name: 'חינמי',
    price: '₪0',
    period: 'לתמיד',
    features: [
      '5 המרות ביום',
      'עד 500 תווים להמרה',
      'יצוא PNG בלבד',
      'סימן מים',
    ],
    highlight: false,
  },
  {
    id: 'monthly',
    name: 'פרמיום חודשי',
    price: '₪29',
    period: 'לחודש',
    features: [
      'המרות ללא הגבלה',
      'עד 5,000 תווים להמרה',
      'יצוא PNG + PDF',
      'ללא סימן מים',
      'עדיפות בתור השרת',
    ],
    highlight: true,
  },
  {
    id: 'yearly',
    name: 'פרמיום שנתי',
    price: '₪199',
    period: 'לשנה',
    features: [
      'הכל בחודשי +',
      'חסכון של 43%',
      'תמיכה מועדפת',
      'גישה מוקדמת לתכונות חדשות',
    ],
    highlight: false,
  },
];

export default function PaywallModal({ visible, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>

          {/* Handle */}
          <View style={styles.handle} />

          {/* Header */}
          <Text style={styles.crown}>👑</Text>
          <Text style={styles.title}>שדרג לפרמיום</Text>
          <Text style={styles.subtitle}>הסר מגבלות וגלה את מלוא הפוטנציאל</Text>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tiersRow}
          >
            {TIERS.map(tier => (
              <View
                key={tier.id}
                style={[styles.tierCard, tier.highlight && styles.tierCardHL]}
              >
                {tier.highlight && (
                  <View style={styles.popularBadge}>
                    <Text style={styles.popularBadgeText}>הכי פופולרי</Text>
                  </View>
                )}
                <Text style={[styles.tierName, tier.highlight && styles.tierNameHL]}>
                  {tier.name}
                </Text>
                <Text style={[styles.tierPrice, tier.highlight && styles.tierPriceHL]}>
                  {tier.price}
                </Text>
                <Text style={styles.tierPeriod}>{tier.period}</Text>

                <View style={styles.featureList}>
                  {tier.features.map(f => (
                    <View key={f} style={styles.featureRow}>
                      <Text style={[styles.featureCheck, tier.highlight && styles.featureCheckHL]}>
                        ✓
                      </Text>
                      <Text style={styles.featureText}>{f}</Text>
                    </View>
                  ))}
                </View>

                {tier.id !== 'free' && (
                  <TouchableOpacity
                    style={[styles.buyBtn, tier.highlight && styles.buyBtnHL]}
                    activeOpacity={0.75}
                    onPress={() => {
                      // Coming Soon — payment not implemented
                    }}
                  >
                    <Text style={[styles.buyBtnText, tier.highlight && styles.buyBtnTextHL]}>
                      בקרוב
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>המשך בחינמי</Text>
          </TouchableOpacity>

        </Pressable>
      </Pressable>
    </Modal>
  );
}

const PURPLE = '#7C3AED';
const PURPLE_LIGHT = '#EDE9FE';

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 36,
    paddingHorizontal: 16,
    paddingTop: 12,
    alignItems: 'center',
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E5E7EB',
    marginBottom: 20,
  },
  crown: {
    fontSize: 40,
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111827',
    writingDirection: 'rtl',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: '#6B7280',
    writingDirection: 'rtl',
    marginBottom: 24,
    textAlign: 'center',
  },

  // Tier cards
  tiersRow: {
    gap: 12,
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  tierCard: {
    width: 200,
    backgroundColor: '#F9FAFB',
    borderRadius: 18,
    borderWidth: 2,
    borderColor: '#E5E7EB',
    padding: 20,
    alignItems: 'center',
  },
  tierCardHL: {
    backgroundColor: PURPLE_LIGHT,
    borderColor: PURPLE,
  },
  popularBadge: {
    position: 'absolute',
    top: -14,
    backgroundColor: PURPLE,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  popularBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  tierName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#374151',
    writingDirection: 'rtl',
    marginBottom: 8,
    marginTop: 8,
  },
  tierNameHL: {
    color: PURPLE,
  },
  tierPrice: {
    fontSize: 32,
    fontWeight: '800',
    color: '#111827',
  },
  tierPriceHL: {
    color: PURPLE,
  },
  tierPeriod: {
    fontSize: 13,
    color: '#9CA3AF',
    writingDirection: 'rtl',
    marginBottom: 16,
  },
  featureList: {
    width: '100%',
    gap: 8,
    marginBottom: 20,
  },
  featureRow: {
    flexDirection: 'row-reverse',
    gap: 8,
    alignItems: 'flex-start',
  },
  featureCheck: {
    fontSize: 13,
    color: '#10B981',
    fontWeight: '700',
    lineHeight: 18,
  },
  featureCheckHL: {
    color: PURPLE,
  },
  featureText: {
    fontSize: 13,
    color: '#374151',
    writingDirection: 'rtl',
    flex: 1,
    textAlign: 'right',
    lineHeight: 18,
  },
  buyBtn: {
    width: '100%',
    backgroundColor: '#E5E7EB',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  buyBtnHL: {
    backgroundColor: PURPLE,
  },
  buyBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#9CA3AF',
    writingDirection: 'rtl',
  },
  buyBtnTextHL: {
    color: '#FFFFFF',
  },

  // Bottom close
  closeBtn: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  closeBtnText: {
    fontSize: 15,
    color: '#9CA3AF',
    writingDirection: 'rtl',
  },
});
