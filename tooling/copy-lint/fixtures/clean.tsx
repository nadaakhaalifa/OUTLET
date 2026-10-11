export const B = ({ viewers, left, pct }: { viewers: number; left: number; pct: number }) => (
  <View>
    <Text>{`${viewers} people are viewing this`}</Text>
    <Text>{`Only ${left} left in stock`}</Text>
    <Text>{`${pct}% off verified`}</Text>
    <Text>{t("stock.remaining", { count: left })}</Text>
    <Text>2 items in your bag</Text>
    <Text>Step 2 of 4</Text>
    <Text>Delivery in 2-3 days</Text>
    <Switch value={false} accessibilityLabel="marketing_push" />
    <Switch value={true} accessibilityLabel="dark_mode" />
    <Text>لا شكرا</Text>
    <Text>سيتم التوصيل خلال ٢ إلى ٣ أيام</Text>
  </View>
);
